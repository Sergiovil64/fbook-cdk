import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FbookCdkStack } from '../lib/fbook-cdk-stack';

describe('FbookCdkStack — Cognito OIDC Authorization Server', () => {
  let template: Template;

  beforeAll(() => {
    const app   = new cdk.App();
    const stack = new FbookCdkStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // User Pool
  // ───────────────────────────────────────────────────────────────────────────
  test('creates a Cognito User Pool with the correct name', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'fbook-user-pool',
    });
  });

  test('the User Pool allows self sign-up', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    });
  });

  test('the User Pool uses email as the sign-in alias', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
    });
  });

  test('the User Pool has automatic email verification', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AutoVerifiedAttributes: Match.arrayWith(['email']),
    });
  });

  test('the password policy requires at least 8 characters with uppercase, lowercase and digits', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: {
          MinimumLength:    8,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers:   true,
        },
      },
    });
  });

  test('account recovery is email-only', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AccountRecoverySetting: {
        RecoveryMechanisms: [
          { Name: 'verified_email', Priority: 1 },
        ],
      },
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Cognito Domain
  // ───────────────────────────────────────────────────────────────────────────
  test('creates a Cognito Domain with the correct prefix', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'fbook-auth',
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // App Client — Authorization Code Flow with PKCE
  // ───────────────────────────────────────────────────────────────────────────
  test('the App Client is named fbook-web-client', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'fbook-web-client',
    });
  });

  test('the App Client has no client_secret (public client for PKCE)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
    });
  });

  test('only Authorization Code Grant is enabled (Implicit is disabled)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthFlows:               ['code'], // authorization_code only
      AllowedOAuthFlowsUserPoolClient: true,
    });
  });

  test('scopes are limited to openid and email (no profile scope)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthScopes: ['openid', 'email'],
    });
  });

  test('only the Cognito native provider is enabled (no social IdPs)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      SupportedIdentityProviders: ['COGNITO'],
    });
  });

  test('token revocation is enabled', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      EnableTokenRevocation: true,
    });
  });

  test('user existence error prevention is enabled', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      PreventUserExistenceErrors: 'ENABLED',
    });
  });

  test('callback URLs are defined', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.arrayWith(['http://localhost:3000/callback']),
    });
  });

  test('logout URLs are defined', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      LogoutURLs: Match.arrayWith(['http://localhost:3000/']),
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CloudFormation Outputs
  // ───────────────────────────────────────────────────────────────────────────
  test('UserPoolId is exported', () => {
    template.hasOutput('UserPoolId', { Export: { Name: 'FbookUserPoolId' } });
  });

  test('UserPoolClientId is exported', () => {
    template.hasOutput('UserPoolClientId', { Export: { Name: 'FbookUserPoolClientId' } });
  });

  test('AuthorizationEndpoint is exported', () => {
    template.hasOutput('AuthorizationEndpoint', { Export: { Name: 'FbookAuthorizationEndpoint' } });
  });

  test('TokenEndpoint is exported', () => {
    template.hasOutput('TokenEndpoint', { Export: { Name: 'FbookTokenEndpoint' } });
  });

  test('JwksUri is exported', () => {
    template.hasOutput('JwksUri', { Export: { Name: 'FbookJwksUri' } });
  });

  test('OidcDiscoveryDocument is exported', () => {
    template.hasOutput('OidcDiscoveryDocument', { Export: { Name: 'FbookOidcDiscoveryDocument' } });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Resource counts
  // ───────────────────────────────────────────────────────────────────────────
  test('the stack creates exactly 1 User Pool', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  test('the stack creates exactly 1 User Pool Domain', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  test('the stack creates exactly 1 App Client', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  });
});
