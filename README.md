# fbook-cdk

AWS CDK (TypeScript) infrastructure for **Fbook** — a social network built on microservices. Provisions a full VPC with three NestJS microservices running on ECS Fargate, fronted by an Application Load Balancer and backed by DynamoDB.

---

## Architecture overview

```
Internet
   │  :80
   ▼
Application Load Balancer  (public subnets, HTTP)
   │  /v1/usuarios*       → ECS Service fbook-service-usuario
   │  /v1/amistades*      → ECS Service fbook-service-amistad
   │  /v1/publicaciones*  → ECS Service fbook-service-publicacion
   │  /v1/comentarios*    → ECS Service fbook-service-publicacion
   │  /v1/reacciones*     → ECS Service fbook-service-publicacion
   ▼
ECS Cluster fbook-cluster (Fargate, private subnets)
   fbook-service-usuario      — 3 tasks, port 3000
   fbook-service-amistad      — 3 tasks, port 3000
   fbook-service-publicacion  — 3 tasks, port 3000

Cloud Map (fbook.local) — inter-service discovery
   usuario.fbook.local     → tasks of fbook-service-usuario
   publicacion.fbook.local → tasks of fbook-service-publicacion

DynamoDB (on-demand, IAM Task Role per service)
   Task Role usuario     → table Usuarios + Cognito (AdminCreateUser, AdminSetUserPassword, AdminDeleteUser)
   Task Role amistad     → table Amistades
   Task Role publicacion → tables Publicaciones, Comentarios, Reacciones

CloudWatch Logs
   /ecs/fbook-usuario
   /ecs/fbook-amistad
   /ecs/fbook-publicacion

CloudWatch Dashboard fbook-overview
   Errores recientes (EMF StatusCode>=400) · Latencia p50/p99 · Throughput · ECS CPU/Mem · ALB 4XX/5XX

CodePipeline V2 (CI + CD)
   fbook-pipeline-ci          (push main + PRs → type-check)
   fbook-pipeline-usuario     (tag usuario-v* → build + ECS update)
   fbook-pipeline-amistad     (tag amistad-v*)
   fbook-pipeline-publicacion (tag publicacion-v*)

Cognito User Pool (separate stack — OIDC/PKCE auth server)
```

---

## Stacks

| Stack | Description |
|-------|-------------|
| `FbookCdkStack` | Cognito User Pool (OIDC Authorization Server) |
| `FbookNetworkStack` | VPC, subnets, NAT Gateway, security groups (ALB + ECS) |
| `FbookClusterStack` | ECS Cluster, Cloud Map namespace, ECR repositories, Task Execution Role |
| `FbookAlbStack` | Application Load Balancer with path-based routing |
| `FbookUsersStack` | ECS Fargate service + DynamoDB `Usuarios` |
| `FbookAmistadStack` | ECS Fargate service + DynamoDB `Amistades` |
| `FbookPublicationStack` | ECS Fargate service + DynamoDB `Publicaciones`, `Comentarios`, `Reacciones` |
| `FbookDashboardStack` | CloudWatch Dashboard `fbook-overview` (logs EMF, latencia, ECS CPU/Mem, ALB 4XX/5XX) |
| `FbookPipelineStack` | 3 CodePipeline V2 (CD) — uno por microservicio, disparados por tags `<svc>-v*` |
| `FbookCiStack` | CodePipeline V2 (CI) — type-check + build, dispara en push a `main` y PRs |

---

## Prerequisites

| Tool | Install / notes |
|------|-----------------|
| Node.js ≥ 18 | https://nodejs.org |
| AWS CLI ≥ 2 | configured with profile `fbook` |
| AWS CDK CLI 2.x | `npm install -g aws-cdk` |

### CodeStar Connection (manual, one-time)

The CI/CD pipelines source from GitHub via an **AWS CodeStar Connection** (CodeConnections). This connection requires a manual OAuth handshake with GitHub and **cannot** be created by CDK. Steps:

1. AWS Console → **Developer Tools → Settings → Connections** → *Create connection* → GitHub.
2. Name: `fbook-github-connection`. Authorize the *AWS Connector for GitHub* app on the repos `Sergiovil64/fbook-api` and `Sergiovil64/fbook-cdk`.
3. Wait until the connection status is **Available** (not *Pending*).
4. Copy the connection ARN.

Pass the ARN to CDK via env var **before** deploying `FbookPipelineStack` or `FbookCiStack`:

```powershell
$env:FBOOK_CODESTAR_CONN_ARN = "arn:aws:codeconnections:us-east-1:140858350333:connection/<id>"
```

If unset, `bin/fbook-cdk.ts` falls back to a hard-coded ARN (the project default). For new accounts this default will not work — set the env var.

---

## Setup

```bash
git clone <repo-url>
cd fbook-cdk
npm install
```

Set your AWS account and region:

```bash
# Bash
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text --profile fbook)
export CDK_DEFAULT_REGION=us-east-1
```

```powershell
# PowerShell
$env:CDK_DEFAULT_ACCOUNT = (aws sts get-caller-identity --query Account --output text --profile fbook)
$env:CDK_DEFAULT_REGION  = "us-east-1"
```

Bootstrap CDK (first time only per account/region):

```bash
npx cdk bootstrap --profile fbook
```

---

## Deploy

```bash
# Validate without deploying
npx cdk synth --profile fbook
```

### First-time deploy

The ECR repositories are created by CDK but start empty. ECS cannot start tasks without images,
so the service stacks must be deployed **after** pushing the images. Follow this order:

**Step 1 — Deploy infrastructure (no ECS services yet):**
```bash
npx cdk deploy FbookCdkStack FbookNetworkStack FbookClusterStack FbookAlbStack --profile fbook
```

**Step 2 — Push Docker images to ECR** (from the microservices repo `fbook-api`):
```bash
./push-to-ecr.sh fbook
```

**Step 3 — Deploy ECS services (images are now available):**
```bash
npx cdk deploy FbookUsersStack FbookAmistadStack FbookPublicationStack --profile fbook
```

### Subsequent deploys

After the first deploy, infrastructure changes can be applied with:
```bash
npx cdk deploy --all --profile fbook
```

> ⚠️ **Cross-stack reference workaround.** If a `cdk deploy --all` ever fails with `Cannot delete export ... as it is in use by ...`, deploy the consumer stacks first to drop their imports, then re-run `--all`:
> ```bash
> npx cdk deploy FbookAmistadStack FbookPublicationStack --profile fbook
> npx cdk deploy --all --profile fbook
> ```

### Pipelines & CI/CD

`FbookPipelineStack` provisions 3 CD pipelines (one per microservice). `FbookCiStack` provisions the CI pipeline. Both depend on the CodeStar Connection above.

| Pipeline                     | Trigger                                                       | Stages                       |
| ---------------------------- | ------------------------------------------------------------- | ---------------------------- |
| `fbook-pipeline-ci`          | Push to `main` + PR (open/updated) against `main`             | Source → Build (type-check)  |
| `fbook-pipeline-usuario`     | Push of tag matching `usuario-v*`                             | Source → Build → Deploy ECS  |
| `fbook-pipeline-amistad`     | Push of tag matching `amistad-v*`                             | Source → Build → Deploy ECS  |
| `fbook-pipeline-publicacion` | Push of tag matching `publicacion-v*`                         | Source → Build → Deploy ECS  |

Triggers are CodePipeline V2 native (`Pipeline.triggers` with `pushFilter` / `pullRequestFilter`) — **not** EventBridge. CodeConnections does not emit `referenceCreated` events for tag pushes; V2 native triggers receive the webhook directly from the connection.

The Build stage of each CD pipeline runs `docker build --target production` (the Dockerfiles' last stage is `development` and would otherwise be picked up by default), uses ECR Public (`public.ecr.aws/docker/library/node:20-alpine`) as the base image to avoid Docker Hub rate limits, and derives the version with `git tag --points-at HEAD | grep "^${SERVICE}-v"` to support multi-service tagging on the same commit.

The Deploy stage runs `aws ecs update-service --force-new-deployment` and polls `services[0].deployments[?status==PRIMARY].rolloutState` for up to 30 minutes (60 attempts × 30s). It does **not** use `aws ecs wait services-stable` because that command has a fixed 10-minute timeout and fails cosmetically when stale deployments are in flight.

To destroy/recreate pipelines without losing ECR images:

```bash
npx cdk destroy FbookPipelineStack FbookCiStack --profile fbook
# ECR repositories survive (RETAIN); pipelines are gone.
npx cdk deploy FbookPipelineStack FbookCiStack --profile fbook
```

### CloudWatch Dashboard

`FbookDashboardStack` provisions the dashboard `fbook-overview` (region `us-east-1`). Widgets:

- **Errores recientes — usuario / amistad / publicacion** (Logs Insights filtering EMF lines with `StatusCode >= 400`)
- **Latencia request (p50 / p99)** from EMF metrics
- **Throughput y errores** (`RequestCount` / `ErrorCount` from EMF)
- **ECS CPU / Memory utilization** per service
- **ALB healthy hosts** and **5XX** per target group
- **ALB 4XX** per target group (covers 401s from the JwtAuthGuard, which run before the EMF interceptor and therefore do not produce EMF lines)

URL is exported as `FbookDashboardStack.DashboardUrl`.

### Key outputs

| Output | Description |
|--------|-------------|
| `FbookCdkStack.UserPoolId` | Cognito User Pool ID — needed by all services (`COGNITO_USER_POOL_ID`) |
| `FbookCdkStack.UserPoolClientId` | Cognito App Client ID — needed to call `InitiateAuth` (`COGNITO_CLIENT_ID`) |
| `FbookAlbStack.AlbDnsName` | Public DNS of the ALB — base URL for all API calls |
| `FbookClusterStack.ClusterName` | ECS Cluster name — used by CI/CD |
| `FbookClusterStack.RepoUsuarioUri` | ECR URI for service-usuario |
| `FbookClusterStack.RepoAmistadUri` | ECR URI for service-amistad |
| `FbookClusterStack.RepoPublicacionUri` | ECR URI for service-publicacion |
| `FbookUsersStack.UsuarioServiceName` | ECS Service name — used by CI/CD |
| `FbookAmistadStack.AmistadServiceName` | ECS Service name — used by CI/CD |
| `FbookPublicationStack.PublicacionServiceName` | ECS Service name — used by CI/CD |

---

## Tear down

```bash
npx cdk destroy --all --profile fbook
```

DynamoDB tables are destroyed (`removalPolicy: DESTROY`). ECR repositories are **retained** (`removalPolicy: RETAIN`) to avoid losing images.

---

## Development commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run watch` | Watch and recompile |
| `npm test` | Run Jest unit tests |
| `npx cdk synth` | Synthesize CloudFormation templates |
| `npx cdk diff` | Show changes vs deployed stacks |
| `npx cdk deploy --all` | Deploy all stacks |
| `npx cdk destroy --all` | Tear down all stacks |
