// ─── Named Types ──────────────────────────────────────────────────────────────

/**
 * Result of the token header inspection.
 * Lets the UI confirm that the IAS token (x-identity-token) is present
 * and distinct from the XSUAA token (Authorization: Bearer).
 */
type TokenCheckResult {
  hasXsuaaToken : Boolean;   // true if Authorization header was present
  xsuaaKid      : String;    // kid from XSUAA JWT header — expect "default-jwt-key"
  xsuaaIssuer   : String;    // iss from XSUAA JWT payload
  xsuaaEmail    : String;    // email / user_name from XSUAA JWT payload

  hasIasToken   : Boolean;   // true if x-identity-token header was present
  iasKid        : String;    // kid from IAS JWT header — IAS signing key GUID
  iasIssuer     : String;    // iss — should be your IAS tenant URL
  iasEmail      : String;    // email from IAS JWT payload
  iasSubject    : String;    // sub — IAS user GUID

  errorMessage  : String;    // decode/parse errors, if any
  rawIasToken   : String;    // full IAS JWT — returned for manual curl testing only
}

/**
 * Result of a deploy or undeploy operation against the target CPI tenant.
 */
type DeployResult {
  status       : String;    // "success" | "error"
  httpStatus   : Integer;   // HTTP status code from the CPI API
  message      : String;    // human-readable summary
  responseData : String;    // raw CPI API response body (JSON string)
}

/**
 * Result of listing integration artifacts from the target CPI.
 */
type ArtifactsResult {
  status       : String;
  httpStatus   : Integer;
  artifacts    : String;    // JSON array of {Id, Name, Version, PackageId} as string
  errorMessage : String;
}

/**
 * Result of listing iFlows within a package.
 */
type IflowsResult {
  status       : String;
  httpStatus   : Integer;
  artifacts    : String;    // JSON array of {Id, Name, Version, DeployedOn} as string
  errorMessage : String;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@(path: '/api/DeployService')
@impl: './deploy-service.js'
service DeployService {

  /**
   * Inspect what the AppRouter forwarded.
   * CDS function (GET) — safe, no side effects.
   */
  @(requires: 'authenticated-user')
  function checkToken() returns TokenCheckResult;

  /**
   * List integration design-time artifacts from the target CPI.
   * Validates the destination + token exchange is working before attempting deploy.
   */
  @(requires: 'authenticated-user')
  function getArtifacts(
    destinationName : String default 'target-cpi'
  ) returns ArtifactsResult;

  /**
   * List iFlows within a specific integration package.
   */
  @(requires: 'authenticated-user')
  function getIflows(
    destinationName : String default 'target-cpi',
    packageId       : String not null
  ) returns IflowsResult;

  /**
   * Trigger iFlow deployment on the target CPI tenant (batch operation).
   * Uses the IAS token from x-identity-token as subject for OAuth2UserTokenExchange.
   * The named user will appear in the CPI audit log.
   */
  @(requires: 'authenticated-user')
  action deployArtifact(
    artifactIds     : array of String not null,
    destinationName : String default 'target-cpi'
  ) returns {
    status  : String;
    results : array of {
      artifactId : String;
      status     : String;
      message    : String;
    };
  };

  /**
   * Trigger iFlow undeployment (batch operation — stop running artifacts) on the target CPI tenant.
   */
  @(requires: 'authenticated-user')
  action undeployArtifact(
    artifactIds     : array of String not null,
    destinationName : String default 'target-cpi'
  ) returns {
    status  : String;
    results : array of {
      artifactId : String;
      status     : String;
      message    : String;
    };
  };
}
