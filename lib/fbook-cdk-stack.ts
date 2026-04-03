import * as cdk from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * FbookCdkStack
 *
 * Provisions an Amazon Cognito User Pool configured as an OIDC Authorization Server.
 * Authentication method: email + password only (no social / federated identity providers).
 *
 * The User Pool exposes standard OAuth 2.0 / OIDC endpoints under the Cognito domain:
 *   - /oauth2/authorize   → starts the Authorization Code Flow with PKCE
 *   - /oauth2/token       → exchanges the code for an ID token, Access token and Refresh token
 *   - /oauth2/userInfo    → OIDC UserInfo endpoint
 *   - /.well-known/openid-configuration → OIDC Discovery Document
 *   - /.well-known/jwks.json            → public keys for token verification (JWKS)
 *
 * Implemented flow: Authorization Code Flow with PKCE (RFC 7636)
 *   1. The app generates a code_verifier (random) and code_challenge = BASE64URL(SHA-256(code_verifier))
 *   2. Redirects the user to /oauth2/authorize with response_type=code, code_challenge, code_challenge_method=S256
 *   3. The user authenticates with email + password in the Cognito Hosted UI
 *   4. Cognito redirects to the callbackUrl with the authorization code
 *   5. The app POSTs to /oauth2/token sending code + code_verifier (never in the browser)
 *   6. Cognito validates code_verifier against code_challenge and returns the tokens
 *
 * ID token claims available with the openid + email scopes:
 *   sub, email, email_verified, iss, aud, exp, iat
 */
export class FbookCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const userPool = new cognito.UserPool(this, 'FbookUserPool', {
      userPoolName: 'fbook-user-pool',

      selfSignUpEnabled: true,

      signInAliases: { email: true },
      autoVerify:    { email: true },

      standardAttributes: {
        email: { required: true, mutable: true },
      },

      passwordPolicy: {
        minLength:            8,
        requireLowercase:     true,
        requireUppercase:     true,
        requireDigits:        true,
        requireSymbols:       false,
        tempPasswordValidity: cdk.Duration.days(7),
      },

      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const domainPrefix = 'fbook-auth';

    const userPoolDomain = userPool.addDomain('FbookUserPoolDomain', {
      cognitoDomain: { domainPrefix },
    });

    const userPoolClient = userPool.addClient('FbookWebClient', {
      userPoolClientName: 'fbook-web-client',
      generateSecret:     false,

      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },

        // openid  → enables OIDC; issues an ID token
        // email   → includes email + email_verified in the ID token
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
        ],

        callbackUrls: [
          'http://localhost:3000/callback',
          'https://myapp.example.com/callback',
        ],

        logoutUrls: [
          'http://localhost:3000/',
          'https://myapp.example.com/',
        ],
      },

      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],

      preventUserExistenceErrors: true,

      enableTokenRevocation: true,

      accessTokenValidity:  cdk.Duration.hours(1),
      idTokenValidity:      cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    const region    = cdk.Aws.REGION;
    const poolId    = userPool.userPoolId;
    const baseUrl   = userPoolDomain.baseUrl();   // https://<prefix>.auth.<region>.amazoncognito.com

    const issuerUrl = cdk.Fn.join('', [
      'https://cognito-idp.', region, '.amazonaws.com/', poolId,
    ]);

    new cdk.CfnOutput(this, 'UserPoolId', {
      value:       poolId,
      description: 'Cognito User Pool ID',
      exportName:  'FbookUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value:       userPoolClient.userPoolClientId,
      description: 'Public App Client ID (used by the app to start the PKCE flow)',
      exportName:  'FbookUserPoolClientId',
    });

    new cdk.CfnOutput(this, 'OidcIssuer', {
      value:       issuerUrl,
      description: 'OIDC Issuer — use as "issuer" in your OIDC client configuration',
      exportName:  'FbookOidcIssuer',
    });

    new cdk.CfnOutput(this, 'OidcDiscoveryDocument', {
      value:       cdk.Fn.join('', [issuerUrl, '/.well-known/openid-configuration']),
      description: 'OIDC Discovery Document: auto-discovers all endpoints and metadata',
      exportName:  'FbookOidcDiscoveryDocument',
    });

    new cdk.CfnOutput(this, 'JwksUri', {
      value:       cdk.Fn.join('', [issuerUrl, '/.well-known/jwks.json']),
      description: 'JWKS URI: RSA public keys for verifying JWT token signatures',
      exportName:  'FbookJwksUri',
    });

    new cdk.CfnOutput(this, 'AuthorizationEndpoint', {
      value:       cdk.Fn.join('', [baseUrl, '/oauth2/authorize']),
      description: 'Step 1 — redirect here with response_type=code&code_challenge=...&code_challenge_method=S256',
      exportName:  'FbookAuthorizationEndpoint',
    });

    new cdk.CfnOutput(this, 'TokenEndpoint', {
      value:       cdk.Fn.join('', [baseUrl, '/oauth2/token']),
      description: 'Step 2 — POST here with grant_type=authorization_code&code=...&code_verifier=...',
      exportName:  'FbookTokenEndpoint',
    });

    new cdk.CfnOutput(this, 'UserInfoEndpoint', {
      value:       cdk.Fn.join('', [baseUrl, '/oauth2/userInfo']),
      description: 'OIDC UserInfo endpoint — GET with Authorization: Bearer <access_token>',
      exportName:  'FbookUserInfoEndpoint',
    });

    new cdk.CfnOutput(this, 'LogoutEndpoint', {
      value:       cdk.Fn.join('', [baseUrl, '/logout']),
      description: 'Logout endpoint — invalidates the Hosted UI session',
      exportName:  'FbookLogoutEndpoint',
    });
  }
}
