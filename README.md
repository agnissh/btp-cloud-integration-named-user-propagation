# btp-named-user-propagation

End-to-end reference implementation for **cross-subaccount named user principal propagation** on SAP BTP Cloud Foundry.

A named user in a source subaccount calls the SAP Integration Suite (Cloud Integration) OData API in a separate target subaccount via a UI5 app. The CPI Audit Log records the actual user email as the actor — not a technical OAuth client ID.

---

## Architecture

### Stack

| Layer | Technology |
|---|---|
| Frontend | UI5 (SAPUI5 freestyle) |
| Approuter | `@sap/approuter` v23 |
| Backend | CAP Node.js v10 (`@sap/cds`) |
| Connectivity | `@sap-cloud-sdk/connectivity` v4 |
| Deployment | MTA on Cloud Foundry |

### Token chain

Both subaccounts trust the **same IAS tenant**. The flow produces a named-user CPI access token in two hops.

1. User logs in through the approuter via the shared IAS tenant.
2. XSUAA mints a JWT and embeds the IAS login token in `xs.system.attributes["ias-token"]`.  
   Requires: `system-attributes: ["ias-token"]` in `xs-security.json` and `xsuaa-persist-corporate-idp-token = Expression: true` as a Self-defined Attribute on the source app in IAS.
3. The CAP backend extracts the IAS token from the XSUAA JWT.
4. **Hop 1 – IAS app-to-app token exchange** (adds CPI audience):
   ```
   POST https://<ias-tenant>/oauth2/token
     grant_type    = urn:ietf:params:oauth:grant-type:jwt-bearer
     assertion     = <user IAS login token>
     resource      = urn:sap:identity:application:provider:name:<dependency-name>
     client_id     = <source IAS app client id>
     client_secret = <source IAS app secret>
   ```
   Returns a new IAS token with `aud = <CPI IAS app client id>`. The `sub` / `email` of the original user is preserved.
5. **Hop 2 – CPI XSUAA jwt-bearer exchange** (mints CPI access token):
   ```
   POST https://<cpi-subdomain>.authentication.<region>.hana.ondemand.com/oauth/token
     grant_type    = urn:ietf:params:oauth:grant-type:jwt-bearer
     assertion     = <Hop 1 token>
     client_id     = <CPI service key clientid>
     client_secret = <CPI service key clientsecret>
   ```
   Returns a CPI XSUAA access token scoped to the named user.
6. Call CPI OData API with the access token:
   ```
   GET /api/v1/IntegrationPackages
   Authorization: Bearer <access token>
   ```

### Why not OAuth2UserTokenExchange directly?

`OAuth2UserTokenExchange` with the source XSUAA token as `subject_token` fails cross-subaccount because the target CPI XSUAA does not trust the source subaccount's signing key. The IAS token is trusted by both subaccounts because both trust the same IAS tenant. Hop 1 re-issues the IAS token with the CPI audience so Hop 2 succeeds.

---

## Project structure

```
btp-named-user-propagation/
├── package.json          workspace root — scripts for dev + CF deploy
├── mta.yaml              MTA deployment descriptor
├── xs-security.json      XSUAA application security config
├── srv/
│   ├── package.json      CAP service workspace (Cloud SDK deps)
│   ├── service.cds       CAP OData service definition
│   ├── deploy-service.js handler: two-hop token exchange + CPI calls
│   └── .cdsrc.json       CDS local dev config (port 4004, dummy auth)
├── router/
│   ├── package.json      AppRouter workspace (@sap/approuter)
│   ├── xs-app.json       route config (proxy /api/* to CAP backend)
│   └── webapp/
│       ├── index.html    UI5 bootstrap
│       ├── Component.js
│       ├── manifest.json
│       ├── view/Main.view.xml        4-panel test UI
│       └── controller/Main.controller.js
└── destinations/
    └── target-cpi.properties  destination import template
```

---

## Local Development

### Prerequisites

- Node.js ≥ 22
- `npm` ≥ 9 (workspaces support)
- `@sap/cds-dk` installed globally: `npm i -g @sap/cds-dk`

### Setup

```bash
git clone <repo-url>
cd btp-named-user-propagation
npm install
```

### Run

```bash
# Start CAP backend + AppRouter concurrently
npm run dev

# Or individually:
npm run srv:dev      # CAP backend only (cds watch, hot-reload, in-memory SQLite)
npm run router:dev   # AppRouter only
```

CAP backend runs on `http://localhost:4004`.  
AppRouter port depends on your local `default-env.json` / approuter config.

---

## BTP Configuration

### Source subaccount

**Destination `target-cpi`** (Connectivity › Destinations):

| Property | Value |
|---|---|
| Type | HTTP |
| URL | `https://<cpi-host>.cfapps.<region>.hana.ondemand.com` |
| Authentication | OAuth2UserTokenExchange |
| Token Service URL | `https://<cpi-subdomain>.authentication.<region>.hana.ondemand.com/oauth/token` |
| Token Service URL Type | Dedicated |
| Client ID | from CPI Process Integration Runtime service key |
| Client Secret | from CPI service key |

Additional property:
```
x_user_token.jwks_uri = https://<ias-tenant>/oauth2/certs
```

**CF environment variables** on `btp-nup-srv`:
```bash
cf set-env btp-nup-srv IAS_TOKEN_URL     "https://<ias-tenant>/oauth2/token"
# IAS_CLIENT_ID is the IAS *application* client ID (UUID from IAS Admin Console →
# your app → Authentication and Access → Client Authentication).
# NOT the CF identity service binding clientid — those are different values.
cf set-env btp-nup-srv IAS_CLIENT_ID     "<ias-app-client-id>"
cf set-env btp-nup-srv IAS_CLIENT_SECRET "<ias-app-client-secret>"
# IAS_RESOURCE — use clientid form (preferred) or name form:
#   urn:sap:identity:application:provider:clientid:<cpi-ias-app-client-id>
#   urn:sap:identity:application:provider:name:<dependency-name>
cf set-env btp-nup-srv IAS_RESOURCE      "urn:sap:identity:application:provider:clientid:<cpi-ias-app-client-id>"
cf restart btp-nup-srv
```

### IAS tenant

1. **Target CPI app** (e.g. `SAP BTP subaccount Integration Suite - Production`):  
   Application APIs › Provided APIs › Add API permission group (e.g. `cpi-api`).

2. **Source app** (e.g. `btp-named-user-propagation`):  
   Application APIs › Dependencies › Add:
   - Dependency Name: `cpi-api` (must match `IAS_RESOURCE` name suffix)
   - Application: Integration Suite – Production
   - API: `cpi-api`

3. **Source app** › Attributes › Self-defined:
   - Name: `xsuaa-persist-corporate-idp-token`
   - Source: Expression
   - Value: `true`

### Target CPI subaccount

**Process Integration Runtime service instance parameters:**
```json
{
  "grant-types": [
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
    "client_credentials"
  ],
  "roles": ["AuthGroup_IntegrationDeveloper"]
}
```

The IAS tenant must be configured as a trusted custom IdP in the target subaccount (Security › Trust Configuration).

The propagated user must have the **`PI_Integration_Developer`** role collection assigned in the target subaccount.

---

## Deploy to Cloud Foundry

### Prerequisites

```bash
npm install -g mbt          # SAP MTA build tool
cf install-plugin multiapps # CF multiapps plugin (cf deploy)
cf login ...                # log in and target your org/space
```

### Build and deploy

```bash
npm run build:cf        # builds .mtar into mta_archives/
npm run deploy:cf       # deploys to CF

# Or in one command:
npm run build:deploy:cf
```

### Post-deploy: set IAS credentials

These are not stored in `mta.yaml` and must be set manually:

```bash
cf set-env btp-nup-srv IAS_TOKEN_URL     "https://<ias-tenant>/oauth2/token"
cf set-env btp-nup-srv IAS_CLIENT_ID     "<ias-app-client-id>"
cf set-env btp-nup-srv IAS_CLIENT_SECRET "<ias-app-client-secret>"
cf set-env btp-nup-srv IAS_RESOURCE      "urn:sap:identity:application:provider:clientid:<cpi-ias-app-client-id>"
cf restart btp-nup-srv
```

> **`IAS_CLIENT_ID` gotcha:** use the UUID from IAS Admin Console → your app → **Authentication and Access → Client Authentication**. This is the *application* clientid, not the CF `identity` service binding's `clientid` (those differ and using the binding clientid causes `JWT aud claim rejected`).

### Post-deploy: IAS manual wiring

After the first deploy, add the IAS cross-app dependency in the IAS Admin Console:

1. Go to Applications & Resources › Applications › `btp-named-user-propagation`
2. APIs › Dependencies › Add
3. Provider: `SAP BTP subaccount Integration Suite - Production`
4. API: `is-prod` (or your named API)
5. Save → `cf restart btp-nup-srv`

### Assign role collection

In the source BTP subaccount, assign `BTP-NUP-Deployer` to the test user.

---

## Test steps

1. Navigate to the approuter URL.
2. Log in via the shared IAS tenant (select the custom IdP if prompted).
3. **Step 1 – Check Token**: confirms XSUAA token present and IAS token embedded (`hasIasToken: true`).
4. **Step 2 – Get Artifacts**: lists Integration Packages from the target CPI — validates the full token chain.
5. **Step 3 – Deploy / Undeploy**: selects an iFlow and triggers deploy/undeploy.
6. In CPI: Monitor › Integrations › Audit Log, filter `Change Type = DEPLOY`. The **User** column must show the user's email (e.g. `user@example.com`) — not a `sb-…` client ID.

---

## Scaling to multiple CPI tenants

The pattern scales without structural changes:

- In IAS, each CPI tenant's app exposes its own named Provided API.
- The source app's Dependencies list grows by one entry per CPI tenant.
- One `target-cpi-<name>` destination per tenant in the source subaccount.
- Pass `destinationName` as a parameter to the CAP actions; set `IAS_RESOURCE` to the matching dependency name, or make it a per-call parameter.

---

## License

This project is provided as a reference implementation. No sensitive credentials, keys, or tenant-specific data are included in this repository. See environment variable setup above for required secrets.
