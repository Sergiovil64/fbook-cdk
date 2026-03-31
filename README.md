# fbook-cdk

AWS CDK (TypeScript) stack that provisions an **Amazon Cognito User Pool** as a fully-compliant **OIDC Authorization Server**.

The stack implements **Authorization Code Flow with PKCE** (RFC 7636) — the most secure grant for browser and mobile applications. No client secret is required; instead, a cryptographic `code_verifier` / `code_challenge` pair prevents authorization codes from being redeemed by anyone other than the client that started the flow.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  FbookCdkStack  (CloudFormation)                         │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Cognito User Pool  (OIDC Authorization Server)     │ │
│  │                                                     │ │
│  │  ┌───────────────────────────────────────────────┐  │ │
│  │  │  User Pool Domain                             │  │ │
│  │  │  fbook-auth.auth.<region>.amazoncognito.com   │  │ │
│  │  │                                               │  │ │
│  │  │  /oauth2/authorize   (Authorization Endpoint) │  │ │
│  │  │  /oauth2/token       (Token Endpoint)         │  │ │
│  │  │  /oauth2/userInfo    (UserInfo Endpoint)      │  │ │
│  │  │  /logout             (Logout Endpoint)        │  │ │
│  │  └───────────────────────────────────────────────┘  │ │
│  │                                                     │ │
│  │  ┌───────────────────────────────────────────────┐  │ │
│  │  │  App Client  (public, no secret)              │  │ │
│  │  │  grant: authorization_code only               │  │ │
│  │  │  scopes: openid  email  profile               │  │ │
│  │  └───────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  OIDC Discovery:  cognito-idp.<region>.amazonaws.com     │
│                   /<userPoolId>/.well-known/...          │
└──────────────────────────────────────────────────────────┘
```

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | https://nodejs.org |
| AWS CLI | ≥ 2 | https://aws.amazon.com/cli |
| AWS CDK CLI | 2.x | `npm install -g aws-cdk` |
| AWS account | — | configured via `aws configure` |

---

## Setup

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd fbook-cdk
npm install
```

### 2. Configure environment variables

The only variables this CDK project reads are the two below. Copy the sample and fill in your values:

```bash
cp .env.sample .env
```

```ini
# .env.sample
CDK_DEFAULT_ACCOUNT=123456789012   # your 12-digit AWS account ID
CDK_DEFAULT_REGION=us-east-1       # target region
```

Set them in your shell before deploying:

```powershell
# PowerShell
$env:CDK_DEFAULT_ACCOUNT = (aws sts get-caller-identity --query Account --output text)
$env:CDK_DEFAULT_REGION  = "us-east-1"
```

```bash
# Bash / macOS / Linux
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=us-east-1
```

> All Cognito endpoints (Authorization, Token, UserInfo, JWKS, etc.) are **CloudFormation Outputs** generated at deploy time — they are not inputs. See the [Deploy](#deploy) section below for the full list.

### 3. Bootstrap CDK (first time only per account/region)

```bash
npx cdk bootstrap
```

---

## Deploy

```bash
npx cdk deploy
```

At the end of the deployment, CloudFormation prints all **Outputs**. These are the reference values your client application will need — copy them wherever your app reads its configuration (env vars, config file, secrets manager, etc.):

```
Outputs:
FbookCdkStack.UserPoolId             = us-east-1_AbCdEfGhI
FbookCdkStack.UserPoolClientId       = 3abc123def456ghi789jkl
FbookCdkStack.CognitoDomain          = https://fbook-auth.auth.us-east-1.amazoncognito.com
FbookCdkStack.OidcIssuer             = https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI
FbookCdkStack.OidcDiscoveryDocument  = https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI/.well-known/openid-configuration
FbookCdkStack.JwksUri                = https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI/.well-known/jwks.json
FbookCdkStack.AuthorizationEndpoint  = https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/authorize
FbookCdkStack.TokenEndpoint          = https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/token
FbookCdkStack.UserInfoEndpoint       = https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/userInfo
FbookCdkStack.LogoutEndpoint         = https://fbook-auth.auth.us-east-1.amazoncognito.com/logout
```

---

## Testing the OIDC endpoints

### Quick health check — Discovery Document

The Discovery Document lists every endpoint and algorithm supported by the Authorization Server. No authentication required.

```bash
curl https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI/.well-known/openid-configuration
```

Expected response (excerpt):

```json
{
  "issuer": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI",
  "authorization_endpoint": "https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/authorize",
  "token_endpoint": "https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/token",
  "userinfo_endpoint": "https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/userInfo",
  "jwks_uri": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI/.well-known/jwks.json",
  "response_types_supported": ["code"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"]
}
```

### Quick health check — JWKS

Fetches the RSA public keys used to verify token signatures.

```bash
curl https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI/.well-known/jwks.json
```

---

## Authorization Code Flow with PKCE — step by step

### Step 1 — Generate PKCE values (client side)

```bash
# Generate a cryptographically random code_verifier (43-128 chars, Base64URL)
CODE_VERIFIER=$(openssl rand -base64 64 | tr -d '=+/' | tr '+/' '-_' | head -c 96)

# Derive code_challenge = BASE64URL(SHA-256(code_verifier))
CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr -d '=' | tr '+/' '-_')

echo "code_verifier:  $CODE_VERIFIER"
echo "code_challenge: $CODE_CHALLENGE"
```

### Step 2 — Open the Authorization Endpoint in the browser

Build the URL and open it. The Cognito Hosted UI handles authentication.

```
https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/authorize
  ?response_type=code
  &client_id=3abc123def456ghi789jkl
  &redirect_uri=http://localhost:3000/callback
  &scope=openid%20email%20profile
  &code_challenge=<CODE_CHALLENGE>
  &code_challenge_method=S256
  &state=<random-csrf-token>
```

After the user logs in, Cognito redirects to:

```
http://localhost:3000/callback?code=AUTHORIZATION_CODE&state=<random-csrf-token>
```

### Step 3 — Exchange the code for tokens

This call must be made from your **backend** (or a local script), never from the browser.

```bash
curl -s -X POST \
  https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "client_id=3abc123def456ghi789jkl" \
  -d "redirect_uri=http://localhost:3000/callback" \
  -d "code=AUTHORIZATION_CODE" \
  -d "code_verifier=$CODE_VERIFIER"
```

Successful response:

```json
{
  "id_token":      "eyJraWQiO...",
  "access_token":  "eyJraWQiO...",
  "refresh_token": "eyJjdHki...",
  "expires_in":    3600,
  "token_type":    "Bearer"
}
```

### Step 4 — Call the UserInfo endpoint

Use the `access_token` to retrieve the authenticated user's profile.

```bash
curl -s \
  https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/userInfo \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

Response:

```json
{
  "sub":        "aaaabbbb-cccc-dddd-eeee-ffffgggghhhh",
  "email":      "user@example.com",
  "given_name": "Jane",
  "family_name":"Doe"
}
```

### Step 5 — Verify the ID token signature (JWKS)

Use any JWT library. Example with [jwt-cli](https://github.com/mike-engel/jwt-cli):

```bash
# Inspect claims without verifying (debugging only)
jwt decode eyJraWQiO...

# Verify signature against JWKS (production)
# Most OIDC libraries (passport-jwt, python-jose, jsonwebtoken, etc.)
# accept the jwks_uri directly and handle key rotation automatically.
```

Key claims to validate in the `id_token`:

| Claim | Expected value |
|-------|---------------|
| `iss` | `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI` |
| `aud` | Your `client_id` |
| `exp` | Must be in the future |
| `token_use` | `id` |

### Step 6 — Refresh the access token

```bash
curl -s -X POST \
  https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "client_id=3abc123def456ghi789jkl" \
  -d "refresh_token=REFRESH_TOKEN"
```

### Step 7 — Logout

Redirect the user to the logout endpoint to invalidate the Hosted UI session.

```
https://fbook-auth.auth.us-east-1.amazoncognito.com/logout
  ?client_id=3abc123def456ghi789jkl
  &logout_uri=http://localhost:3000/
```

---

## Using with an OIDC client library

Most OIDC libraries only need the **issuer URL** and **client ID** — they auto-discover all endpoints via the Discovery Document.

### JavaScript / Node.js (`openid-client`)

```typescript
import { Issuer } from 'openid-client';

const issuer = await Issuer.discover(
  'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI'
);

const client = new issuer.Client({
  client_id:                '3abc123def456ghi789jkl',
  redirect_uris:            ['http://localhost:3000/callback'],
  response_types:           ['code'],
  token_endpoint_auth_method: 'none', // public client
});

// Generate PKCE and build authorization URL
const codeVerifier  = generators.codeVerifier();
const codeChallenge = generators.codeChallenge(codeVerifier);

const authUrl = client.authorizationUrl({
  scope:                  'openid email profile',
  code_challenge:         codeChallenge,
  code_challenge_method:  'S256',
});
```

### Python (`authlib`)

```python
from authlib.integrations.requests_client import OAuth2Session

client = OAuth2Session(
    client_id='3abc123def456ghi789jkl',
    redirect_uri='http://localhost:3000/callback',
    scope='openid email profile',
    code_challenge_method='S256',
)

authorization_url, state = client.create_authorization_url(
    'https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/authorize'
)

# After redirect, exchange the code:
token = client.fetch_token(
    'https://fbook-auth.auth.us-east-1.amazoncognito.com/oauth2/token',
    authorization_response=callback_url,
)
```

---

## Development commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run watch` | Watch for changes and recompile |
| `npm test` | Run Jest unit tests |
| `npx cdk synth` | Synthesize CloudFormation template (no deploy) |
| `npx cdk diff` | Show changes against the currently deployed stack |
| `npx cdk deploy` | Deploy the stack to AWS |
| `npx cdk destroy` | Tear down all resources |

---

## Tear down

```bash
npx cdk destroy
```

> The User Pool has `removalPolicy: DESTROY` so all users and data will be permanently deleted. Change to `RETAIN` before production use.
