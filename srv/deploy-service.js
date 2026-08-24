'use strict';

const cds = require('@sap/cds');
const https = require('https');
const LOG = cds.log('deploy-service');

function decodeJwt(token) {
  try {
    const [rawHeader, rawPayload] = token.split('.');
    const header  = JSON.parse(Buffer.from(rawHeader,  'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'));
    return { header, payload };
  } catch (err) { return null; }
}

function getHttpReq(req) { return req.http?.req ?? req._ ?? req; }

function tokenSummary(token, label) {
  if (!token) { LOG.info(`[${label}] not present`); return; }
  const d = decodeJwt(token);
  if (!d) { LOG.warn(`[${label}] present but could not decode`); return; }
  LOG.info(`[${label}] kid=${d.header.kid} iss=${d.payload.iss} sub=${d.payload.sub} email=${d.payload.email ?? d.payload.user_name ?? '(none)'} aud=${JSON.stringify(d.payload.aud)}`);
}

function extractIasToken(xsuaaToken) {
  if (!xsuaaToken) return null;
  const xd = decodeJwt(xsuaaToken);
  const embedded = xd?.payload?.['xs.system.attributes']?.['ias-token'];
  if (!embedded) return null;
  return Array.isArray(embedded) ? embedded[0] : embedded;
}

function resolveIasToken(httpReq) {
  const headerToken = httpReq.headers?.['x-identity-token'];
  if (headerToken) return { token: headerToken, source: 'x-identity-token header' };
  const authHeader = httpReq.headers?.['authorization'] ?? '';
  const xsuaaToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const embedded = extractIasToken(xsuaaToken);
  if (embedded) return { token: embedded, source: 'xs.system.attributes[ias-token]' };
  return { token: null, source: null };
}

// ── HTTPS helpers ─────────────────────────────────────────────────────────────
function httpsRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request({
      hostname: url.hostname, port: 443,
      path: url.pathname + (url.search || ''), method, headers
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getClientCredentialsToken(tokenUrl, clientId, clientSecret) {
  const params = new URLSearchParams({ grant_type: 'client_credentials' });
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await httpsRequest('POST', tokenUrl,
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
    params.toString());
  const parsed = JSON.parse(res.body);
  if (!parsed.access_token) throw new Error(`client_credentials failed: ${res.body}`);
  return parsed.access_token;
}

async function jwtBearerExchange(tokenServiceURL, clientId, clientSecret, assertion) {
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await httpsRequest('POST', tokenServiceURL,
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
    params.toString());
  const parsed = JSON.parse(res.body);
  if (!parsed.access_token) throw new Error(`jwt-bearer failed (${res.status}): ${res.body}`);
  LOG.info('jwtBearerExchange: success sub=%s', decodeJwt(parsed.access_token)?.payload?.sub ?? '?');
  return parsed.access_token;
}

async function fetchDestinationConfig(destinationName) {
  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
  const creds = vcap.destination?.[0]?.credentials;
  if (!creds?.uri) throw new Error('No destination service binding in VCAP_SERVICES');

  const svcToken = await getClientCredentialsToken(`${creds.url}/oauth/token`, creds.clientid, creds.clientsecret);
  const res = await httpsRequest('GET',
    `${creds.uri}/destination-configuration/v1/subaccountDestinations/${destinationName}`,
    { 'Authorization': `Bearer ${svcToken}`, 'Accept': 'application/json' });
  if (res.status !== 200) throw new Error(`Dest API ${res.status}: ${res.body}`);
  const cfg = JSON.parse(res.body).destinationConfiguration ?? JSON.parse(res.body);
  return {
    url: cfg.URL,
    tokenServiceURL: cfg.tokenServiceURL ?? cfg.TokenServiceURL,
    clientId: cfg.clientId ?? cfg.Client_Id,
    clientSecret: cfg.clientSecret ?? cfg.Client_Secret
  };
}

async function iasApp2AppExchange(userIasToken) {
  const iasUrl      = process.env.IAS_TOKEN_URL;
  const iasClientId = process.env.IAS_CLIENT_ID;
  const iasSecret   = process.env.IAS_CLIENT_SECRET;
  const resource    = process.env.IAS_RESOURCE;
  if (!iasUrl || !iasClientId || !iasSecret || !resource) {
    throw new Error('IAS app2app config missing (IAS_TOKEN_URL / IAS_CLIENT_ID / IAS_CLIENT_SECRET / IAS_RESOURCE)');
  }
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: iasClientId,
    client_secret: iasSecret,
    assertion: userIasToken,
    resource
  });
  const res = await httpsRequest('POST', iasUrl,
    { 'Content-Type': 'application/x-www-form-urlencoded' }, params.toString());
  const parsed = JSON.parse(res.body);
  if (!parsed.access_token) throw new Error(`IAS app2app exchange failed (${res.status}): ${res.body}`);
  const claims = decodeJwt(parsed.access_token)?.payload;
  LOG.info('iasApp2AppExchange: success aud=%s sub=%s', JSON.stringify(claims?.aud), claims?.sub);
  return parsed.access_token;
}

// Two-hop token exchange: IAS login token → CPI access token with named-user attribution.
// Hop 1: IAS app2app exchange (adds CPI audience to token)
// Hop 2: XSUAA jwt-bearer exchange (CPI XSUAA issues an access token)
async function getCpiAccessToken(destinationName, userIasToken) {
  const cfg = await fetchDestinationConfig(destinationName);
  LOG.info('CPI dest: url=%s tokenSvcURL=%s', cfg.url, cfg.tokenServiceURL);
  if (!cfg.tokenServiceURL || !cfg.clientId || !cfg.clientSecret) {
    throw new Error(`Destination missing credentials (tsUrl=${!!cfg.tokenServiceURL} clientId=${!!cfg.clientId})`);
  }
  const cpiAudienceToken = await iasApp2AppExchange(userIasToken);
  const accessToken = await jwtBearerExchange(cfg.tokenServiceURL, cfg.clientId, cfg.clientSecret, cpiAudienceToken);
  return { url: cfg.url, accessToken };
}

class DeployService extends cds.ApplicationService {

  async init() {

    this.before('*', (req) => {
      const httpReq = getHttpReq(req);
      LOG.info('[every-request] event=%s hasXsuaaToken=%s hasIasHeader=%s',
        req.event, !!(httpReq.headers?.['authorization']), !!(httpReq.headers?.['x-identity-token']));
    });

    // ── checkToken ────────────────────────────────────────────────────────────
    this.on('checkToken', async (req) => {
      const httpReq = getHttpReq(req);
      const authHeader = httpReq.headers?.['authorization'] ?? '';
      const xsuaaToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const { token: iasToken, source: iasSource } = resolveIasToken(httpReq);

      tokenSummary(xsuaaToken, 'XSUAA');
      if (iasToken) tokenSummary(iasToken, 'IAS');

      const result = {
        hasXsuaaToken: !!xsuaaToken, xsuaaKid: null, xsuaaIssuer: null, xsuaaEmail: null,
        hasIasToken:   !!iasToken,   iasKid:   null, iasIssuer:   null, iasEmail:   null, iasSubject: null,
        rawIasToken: iasToken ?? null,
        errorMessage: iasToken ? `IAS source: ${iasSource}` : null
      };
      if (xsuaaToken) {
        const d = decodeJwt(xsuaaToken);
        if (d) { result.xsuaaKid = d.header.kid ?? '?'; result.xsuaaIssuer = d.payload.iss ?? '?'; result.xsuaaEmail = d.payload.email ?? d.payload.user_name ?? '?'; }
      }
      if (iasToken) {
        const d = decodeJwt(iasToken);
        if (d) { result.iasKid = d.header.kid ?? '?'; result.iasIssuer = d.payload.iss ?? '?'; result.iasEmail = d.payload.email ?? '?'; result.iasSubject = d.payload.sub ?? '?'; }
      }
      LOG.info('checkToken: hasXsuaa=%s hasIas=%s source=%s', result.hasXsuaaToken, result.hasIasToken, iasSource);
      return result;
    });

    // ── getArtifacts ──────────────────────────────────────────────────────────
    this.on('getArtifacts', async (req) => {
      const { destinationName = 'target-cpi' } = req.data;
      LOG.info('getArtifacts: destination=%s', destinationName);

      const httpReq = getHttpReq(req);
      const { token: iasToken, source } = resolveIasToken(httpReq);
      if (!iasToken) {
        return { status: 'error', httpStatus: 400, artifacts: '[]',
          errorMessage: 'IAS token not found (neither x-identity-token header nor xs.system.attributes).' };
      }
      LOG.info('getArtifacts: IAS token from %s', source);

      let cpi;
      try {
        cpi = await getCpiAccessToken(destinationName, iasToken);
      } catch (e) {
        LOG.error('getArtifacts: token exchange failed: %s', e.message);
        return { status: 'error', httpStatus: 502, artifacts: '[]', errorMessage: `Token exchange: ${e.message}` };
      }

      try {
        const res = await httpsRequest('GET', `${cpi.url}/api/v1/IntegrationPackages`,
          { 'Accept': 'application/json', 'Authorization': `Bearer ${cpi.accessToken}` });
        if (res.status >= 400) {
          return { status: 'error', httpStatus: res.status, artifacts: '[]', errorMessage: res.body };
        }
        const parsed = JSON.parse(res.body);
        const items = parsed?.d?.results ?? parsed?.value ?? [];
        LOG.info('getArtifacts: found %d packages', items.length);
        return { status: 'success', httpStatus: res.status,
          artifacts: JSON.stringify(items.map(p => ({ Id: p.Id, Name: p.Name, Version: p.Version, PackageId: p.Id }))),
          errorMessage: null };
      } catch (e) {
        LOG.error('getArtifacts CPI call failed: %s', e.message);
        return { status: 'error', httpStatus: 500, artifacts: '[]', errorMessage: e.message };
      }
    });

    // ── getIflows ─────────────────────────────────────────────────────────────
    this.on('getIflows', async (req) => {
      const { destinationName = 'target-cpi', packageId } = req.data;
      if (!packageId) {
        return { status: 'error', httpStatus: 400, artifacts: '[]', errorMessage: 'packageId is required' };
      }
      LOG.info('getIflows: destination=%s packageId=%s', destinationName, packageId);

      const httpReq = getHttpReq(req);
      const { token: iasToken } = resolveIasToken(httpReq);
      if (!iasToken) {
        return { status: 'error', httpStatus: 400, artifacts: '[]', errorMessage: 'IAS token not found' };
      }

      let cpi;
      try {
        cpi = await getCpiAccessToken(destinationName, iasToken);
      } catch (e) {
        LOG.error('getIflows: token exchange failed: %s', e.message);
        return { status: 'error', httpStatus: 502, artifacts: '[]', errorMessage: `Token exchange: ${e.message}` };
      }

      try {
        const encodedPackageId = encodeURIComponent(packageId);
        const res = await httpsRequest('GET',
          `${cpi.url}/api/v1/IntegrationPackages('${encodedPackageId}')/IntegrationDesigntimeArtifacts`,
          { 'Accept': 'application/json', 'Authorization': `Bearer ${cpi.accessToken}` });
        if (res.status >= 400) {
          return { status: 'error', httpStatus: res.status, artifacts: '[]', errorMessage: res.body };
        }
        const parsed = JSON.parse(res.body);
        const items = parsed?.d?.results ?? parsed?.value ?? [];
        LOG.info('getIflows: found %d iflows in package %s', items.length, packageId);
        return { status: 'success', httpStatus: res.status,
          artifacts: JSON.stringify(items.map(f => ({ Id: f.Id, Name: f.Name, Version: f.Version, DeployedOn: f.DeployedOn }))),
          errorMessage: null };
      } catch (e) {
        LOG.error('getIflows CPI call failed: %s', e.message);
        return { status: 'error', httpStatus: 500, artifacts: '[]', errorMessage: e.message };
      }
    });

    // ── deployArtifact (batch) ────────────────────────────────────────────────
    this.on('deployArtifact', async (req) => {
      const { artifactIds = [], destinationName = 'target-cpi' } = req.data;
      if (!Array.isArray(artifactIds) || artifactIds.length === 0) {
        return req.error(400, 'artifactIds must be a non-empty array');
      }
      LOG.info('deployArtifact: deploying %d artifacts to %s', artifactIds.length, destinationName);

      const httpReq = getHttpReq(req);
      const { token: iasToken } = resolveIasToken(httpReq);
      if (!iasToken) return req.error(400, 'IAS token not found');

      let cpi;
      try {
        cpi = await getCpiAccessToken(destinationName, iasToken);
      } catch (e) {
        return req.error(502, `Token exchange failed: ${e.message}`);
      }

      // Fetch CSRF token once for all deploys
      let csrf = null;
      try {
        const csrfRes = await httpsRequest('GET', `${cpi.url}/api/v1/`,
          { 'X-CSRF-Token': 'Fetch', 'Authorization': `Bearer ${cpi.accessToken}`, 'Accept': 'application/json' });
        csrf = csrfRes.headers?.['x-csrf-token'];
        LOG.info('deployArtifact: CSRF token fetched: %s', csrf ? 'yes' : 'none');
      } catch (e) {
        LOG.warn('deployArtifact: CSRF fetch failed: %s', e.message);
      }

      const results = [];
      for (const artifactId of artifactIds) {
        try {
          // CPI deploy endpoint requires CSRF + POST with query params (not body)
          const csrfRes = await httpsRequest('GET', `${cpi.url}/api/v1/`,
            { 'X-CSRF-Token': 'Fetch', 'Authorization': `Bearer ${cpi.accessToken}` });
          const csrf = csrfRes.headers?.['x-csrf-token'];

          const deployUrl = `${cpi.url}/api/v1/DeployIntegrationDesigntimeArtifact?Id='${encodeURIComponent(artifactId)}'&Version='active'`;
          const res = await httpsRequest('POST', deployUrl,
            {
              'Accept': 'application/json',
              'Authorization': `Bearer ${cpi.accessToken}`,
              'Content-Length': '0',
              ...(csrf ? { 'X-CSRF-Token': csrf } : {})
            });
          LOG.info('deployArtifact: %s HTTP %s', artifactId, res.status);
          if (res.status >= 400) {
            results.push({ artifactId, status: 'error', message: `HTTP ${res.status}: ${res.body}` });
          } else {
            results.push({ artifactId, status: 'success', message: 'Deploy triggered' });
          }
        } catch (e) {
          results.push({ artifactId, status: 'error', message: e.message });
        }
      }
      return { status: 'success', results };
    });

    // ── undeployArtifact (batch) ──────────────────────────────────────────────
    this.on('undeployArtifact', async (req) => {
      const { artifactIds = [], destinationName = 'target-cpi' } = req.data;
      if (!Array.isArray(artifactIds) || artifactIds.length === 0) {
        return req.error(400, 'artifactIds must be a non-empty array');
      }
      LOG.info('undeployArtifact: undeploying %d artifacts from %s', artifactIds.length, destinationName);

      const httpReq = getHttpReq(req);
      const { token: iasToken } = resolveIasToken(httpReq);
      if (!iasToken) return req.error(400, 'IAS token not found');

      let cpi;
      try {
        cpi = await getCpiAccessToken(destinationName, iasToken);
      } catch (e) {
        return req.error(502, `Token exchange failed: ${e.message}`);
      }

      const results = [];
      for (const artifactId of artifactIds) {
        try {
          const csrfRes = await httpsRequest('GET', `${cpi.url}/api/v1/`,
            { 'X-CSRF-Token': 'Fetch', 'Authorization': `Bearer ${cpi.accessToken}` });
          const csrf = csrfRes.headers?.['x-csrf-token'];

          const res = await httpsRequest('DELETE',
            `${cpi.url}/api/v1/IntegrationRuntimeArtifacts('${artifactId}')`,
            {
              'Accept': 'application/json',
              'Authorization': `Bearer ${cpi.accessToken}`,
              ...(csrf ? { 'X-CSRF-Token': csrf } : {})
            });
          LOG.info('undeployArtifact: %s HTTP %s', artifactId, res.status);
          if (res.status >= 400) {
            results.push({ artifactId, status: 'error', message: `HTTP ${res.status}: ${res.body}` });
          } else {
            results.push({ artifactId, status: 'success', message: 'Undeploy triggered' });
          }
        } catch (e) {
          results.push({ artifactId, status: 'error', message: e.message });
        }
      }
      return { status: 'success', results };
    });

    await super.init();
  }
}

module.exports = DeployService;
