# Fbook CDK — Architecture Documentation

## Overview

This project provisions the AWS infrastructure for **Fbook**, a Facebook-like social network clone, using AWS CDK (TypeScript). The system is composed of three independent NestJS microservices — Usuarios, Amistad, and Publicaciones — each running as an ECS Fargate service backed by dedicated DynamoDB tables.

Authentication is handled by a Cognito User Pool acting as a fully compliant OIDC Authorization Server (Authorization Code Flow + PKCE).

---

## Architecture Diagram

```
                            INTERNET
                                │
                      ┌─────────▼─────────┐
                      │  Internet Gateway  │
                      └─────────┬─────────┘
                                │
            ┌───────────────────▼──────────────────────────┐
            │               VPC  10.0.0.0/16               │
            │                                              │
            │  PUBLIC SUBNETS                              │
            │  ┌────────────────────────────────────────┐  │
            │  │  NAT Gateway (AZ-1a)                   │  │
            │  │  ALB — spans AZ-1a + AZ-1b, HTTP :80   │  │
            │  │    /v1/usuarios*      → TG-Usuarios     │  │
            │  │    /v1/amistades*     → TG-Amistad      │  │
            │  │    /v1/publicaciones* → TG-Publicacion  │  │
            │  │    /v1/comentarios*   → TG-Publicacion  │  │
            │  │    /v1/reacciones*    → TG-Publicacion  │  │
            │  └──────────────────┬─────────────────────┘  │
            │                     │                        │
            │  PRIVATE SUBNETS    │  (sg-ecs)              │
            │  ┌──────────────────▼─────────────────────┐  │
            │  │  ECS Cluster: fbook-cluster (Fargate)  │  │
            │  │                                        │  │
            │  │  fbook-service-usuario   (3 tasks :3000│  │
            │  │  fbook-service-amistad   (3 tasks :3000│  │
            │  │  fbook-service-publicacion(3 tasks:3000│  │
            │  │                                        │  │
            │  │  Cloud Map fbook.local                 │  │
            │  │    usuario.fbook.local                 │  │
            │  │    publicacion.fbook.local             │  │
            │  └────────────────────────────────────────┘  │
            │                                              │
            │  VPC Gateway Endpoint  (DynamoDB — free)     │
            └──────────────────────────────────────────────┘
                    │            │              │
               Usuarios      Amistades    Publicaciones
               (DynamoDB)   (DynamoDB)    Comentarios
                                          Reacciones
                                          (DynamoDB x3)

  Cognito User Pool (OIDC / PKCE)  ←  separate managed stack

  ECR Repositories (managed by CDK)
    fbook-service-usuario
    fbook-service-amistad
    fbook-service-publicacion

  CloudWatch Log Groups
    /ecs/fbook-usuario
    /ecs/fbook-amistad
    /ecs/fbook-publicacion

  CloudWatch Dashboard fbook-overview
    Errores recientes (EMF StatusCode >= 400)
    Latencia p50 / p99 · Throughput · Error rate (EMF)
    ECS CPU / Memory · ALB Healthy hosts · ALB 4XX / 5XX

  CodePipeline V2 (managed by CDK, sourced via CodeStar Connection to GitHub)
    fbook-pipeline-ci          (CI: type-check on push main + PRs)
    fbook-pipeline-usuario     (CD: tag usuario-v*    → build → ECS update)
    fbook-pipeline-amistad     (CD: tag amistad-v*    → build → ECS update)
    fbook-pipeline-publicacion (CD: tag publicacion-v* → build → ECS update)
```

---

## Stack Breakdown

The infrastructure is divided into **10 independent CDK stacks**, each with a single responsibility.

### 1. `FbookCdkStack` — Authentication

Provisions a **Cognito User Pool** configured as an OIDC Authorization Server.

- Authorization Code Flow with PKCE (RFC 7636) — no client secret stored in the browser
- Exports all OIDC endpoints (issuer, JWKS URI, authorize, token, userinfo) as CloudFormation outputs
- Consumed by frontend apps and used by microservices to validate JWT tokens via the JWKS URI

**Why Cognito?** Fully managed service with a generous always-free tier (50,000 MAUs). Eliminates the need to build authentication logic and its OIDC compliance makes it easy to integrate with any standard library.

---

### 2. `FbookNetworkStack` — VPC & Security

The networking foundation shared by all other stacks.

| Resource              | Detail                                                                         |
| --------------------- | ------------------------------------------------------------------------------ |
| VPC                   | `10.0.0.0/16`, 2 Availability Zones                                            |
| Public subnets        | 2 public `/24` subnets — host the ALB and NAT Gateway                          |
| Private subnets       | 2 private `/24` subnets — host the ECS Fargate tasks                           |
| NAT Gateway           | 1 instance in AZ-1a — allows tasks to pull from ECR and write to CloudWatch    |
| DynamoDB VPC Endpoint | Gateway type, free — keeps DynamoDB traffic inside the AWS network             |
| Security Groups       | `sg-alb` (inbound :80 from internet), `sg-ecs` (inbound :3000 from ALB + self) |

**Why 2 AZs?** The Application Load Balancer requires at least 2 Availability Zones to operate.

**Why 1 NAT Gateway?** A NAT Gateway per AZ (~$32/month each) is the production recommendation. For an academic environment one NAT Gateway cuts that cost in half with an acceptable trade-off.

**Why a DynamoDB VPC Gateway Endpoint?** Without it, traffic from ECS tasks to DynamoDB exits through the NAT Gateway and incurs data transfer charges. The Gateway Endpoint routes that traffic within the AWS backbone at no extra cost.

---

### 3. `FbookClusterStack` — ECS Cluster, ECR & Shared Resources

Central stack that provides shared resources to all service stacks.

| Resource              | Detail                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| ECS Cluster           | `fbook-cluster` — Fargate launch type                                           |
| Cloud Map namespace   | `fbook.local` — private DNS for inter-service communication                     |
| ECR Repositories      | `fbook-service-usuario/amistad/publicacion` — `removalPolicy: RETAIN`           |
| CloudWatch Log Groups | `/ecs/fbook-usuario/amistad/publicacion` — here to avoid circular dependencies  |
| Task Execution Role   | Shared IAM role — allows ECS to pull from ECR and write to CloudWatch           |

**Why log groups here and not in each service stack?**
CDK automatically grants the Task Execution Role write access to any log group passed to `ecs.LogDrivers.awsLogs({ logGroup })`. If the log groups lived in the service stacks and the execution role in ClusterStack, CDK would create a circular dependency (ClusterStack → ServiceStack → ClusterStack). Placing log groups here keeps the dependency unidirectional.

**Why `removalPolicy: RETAIN` for ECR?**
ECR repositories contain the Docker images. Destroying the stack should not delete production images accidentally.

---

### 4. `FbookAlbStack` — Load Balancer & Routing

A single **Application Load Balancer** in the public subnets with an HTTP listener on port 80.

| Path pattern          | Target                   | Priority |
| --------------------- | ------------------------ | -------- |
| `/v1/usuarios*`       | TG-Usuarios (IP type)    | 10       |
| `/v1/amistades*`      | TG-Amistad (IP type)     | 20       |
| `/v1/publicaciones*`  | TG-Publicacion (IP type) | 30       |
| `/v1/comentarios*`    | TG-Publicacion (IP type) | 40       |
| `/v1/reacciones*`     | TG-Publicacion (IP type) | 50       |
| anything else         | Fixed 404 JSON response  | —        |

**Why target type IP?** Fargate tasks have no EC2 instance ID. The ALB registers tasks directly by their private IP address, so target type must be `IP` (not `INSTANCE`).

**Why HTTP and not HTTPS?** HTTPS requires a custom domain and an ACM certificate. For academic and testing purposes, HTTP is sufficient.

---

### 5–7. `FbookUsersStack`, `FbookAmistadStack`, `FbookPublicationStack` — Microservices

Each microservice stack follows the same pattern:

```
FargateTaskDefinition (256 CPU, 512 MB)
  └── Task Execution Role  → pull from ECR, write CloudWatch logs
  └── Task Role (per service) → DynamoDB access scoped to own tables only
  └── Container: NestJS app on :3000
       └── Health check: node -e "require('http').get('/health', ...)"
       └── Environment variables injected by CDK (no .env files)

FargateService
  └── desiredCount: 3
  └── Private subnets, no public IP
  └── Cloud Map registration (auto-registers task IP on startup)
  └── Target Group registration (ALB routes traffic to healthy tasks)

Auto Scaling
  └── min: 3 / max: 6
  └── CPU target: 70%
  └── Memory target: 70%
```

#### Inter-service communication

Services communicate via Cloud Map DNS — no hardcoded IPs:

| From service  | Calls                        | Resolved by Cloud Map to       |
| ------------- | ---------------------------- | ------------------------------ |
| amistad       | `http://usuario.fbook.local` | private IP of a usuario task   |
| publicacion   | `http://usuario.fbook.local` | private IP of a usuario task   |
| publicacion   | `http://publicacion.fbook.local` | private IP of a publicacion task |

#### DynamoDB — IAM isolation per service

| Table           | Partition Key | Accessible by Task Role |
| --------------- | ------------- | ----------------------- |
| `Usuarios`      | `id` (STRING) | usuario only            |
| `Amistades`     | `id` (STRING) | amistad only            |
| `Publicaciones` | `id` (STRING) | publicacion only        |
| `Comentarios`   | `id` (STRING) | publicacion only        |
| `Reacciones`    | `id` (STRING) | publicacion only        |

> Partition keys store UUIDs (e.g. `cea88b12-941e-...`) — `STRING`. DynamoDB does **not** allow changing the partition key type after table creation; it is immutable.

---

### 8. `FbookDashboardStack` — CloudWatch Dashboard

A single dashboard `fbook-overview` (region `us-east-1`) that consolidates observability for the 3 microservices.

| Row | Widget                                              | Source                                                 |
| --- | --------------------------------------------------- | ------------------------------------------------------ |
| 1   | Errores recientes (one widget per service)          | Logs Insights — EMF lines with `StatusCode >= 400`     |
| 2   | Latencia request p50 / p99                          | EMF metrics — `Fbook/<Svc>` `RequestLatencyMs`         |
| 2   | Throughput y errores                                | EMF metrics — `RequestCount` + `ErrorCount`            |
| 3   | ECS CPU Utilization (%) per service                 | `AWS/ECS` namespace                                    |
| 3   | ECS Memory Utilization (%) per service              | `AWS/ECS` namespace                                    |
| 4   | ALB Healthy hosts per target group                  | Target group metrics                                   |
| 4   | ALB HTTP 5XX per target group                       | Target group metrics — `TARGET_5XX_COUNT`              |
| 5   | ALB HTTP 4XX per target group (incluye 401 de auth) | Target group metrics — `TARGET_4XX_COUNT`              |

**Why the "Errores recientes" query filters EMF lines.** NestJS does not emit a log line for HTTP errors unless a global exception filter is configured. The only structured record per request is the EMF JSON written by the global `EmfMetricsInterceptor`. CloudWatch Logs Insights auto-parses top-level JSON, so `StatusCode >= 400` works directly without `parse`.

**Why a dedicated 4XX widget.** The `JwtAuthGuard` (Cognito JWT validation) runs **before** the `EmfMetricsInterceptor` in NestJS's request pipeline (Guards → Interceptors). When a request fails JWT validation the guard returns 401 directly and the interceptor never executes — so the 401 does not appear in EMF metrics or in the "Errores recientes" widget. The ALB-level 4XX metric is the only way to see these auth failures.

---

### 9. `FbookPipelineStack` — Continuous Deployment

3 CodePipeline V2 pipelines (one per microservice) — `fbook-pipeline-{usuario,amistad,publicacion}`. Each pipeline has 3 stages:

```
Source (CodeStar Connection → GitHub Sergiovil64/fbook-api, branch main)
  │  triggerOnPush: false (V2 native triggers control firing)
  │  codeBuildCloneOutput: true (full git clone with tags)
  ▼
Build (CodeBuild PipelineProject)
  │  - docker build --target production -f services/<svc>/Dockerfile
  │  - Version derived from `git tag --points-at HEAD | grep "^${SERVICE}-v"`
  │  - Pushes 4 ECR tags: <X.Y.Z>, <X.Y>, <X>, latest (all → same digest)
  │  - Outputs image-info.json artifact
  ▼
Deploy (CodeBuild PipelineProject)
  │  - aws ecs update-service --force-new-deployment
  │  - Polls services[0].deployments[?status==PRIMARY].rolloutState
  │    (60 attempts × 30s = 30 min ceiling)
  │  - Replaces `aws ecs wait services-stable` (fixed 10-min timeout)
```

**Trigger mechanism — Pipeline V2 native.** Each pipeline declares:

```ts
triggers: [{
  providerType: ProviderType.CODE_STAR_SOURCE_CONNECTION,
  gitConfiguration: {
    sourceAction,
    pushFilter: [{ tagsIncludes: [`${svc}-v*`] }],
  },
}]
```

The webhook arrives directly from the CodeStar Connection. **EventBridge does not work** for tag pushes from CodeConnections — verified empirically: a catch-all rule over `aws.codeconnections / codestar-connections / codecommit / codepipeline / codebuild` received zero events for `referenceCreated` with `referenceType=tag`.

**Multi-service tagging on the same commit** is supported because the buildspec uses `git tag --points-at HEAD` (which lists *all* tags at HEAD) followed by a grep for `^${SERVICE}-v`. `git describe --exact-match --tags HEAD` is *not* used — it returns a single tag in non-deterministic order when multiple tags share a commit.

**Docker base image** is `public.ecr.aws/docker/library/node:20-alpine`, the AWS-hosted mirror of the official Docker Hub image. CodeBuild runs from a shared IP pool that easily exceeds Docker Hub's anonymous pull limit (100 / 6h per IP), causing 429 errors. ECR Public has no rate limit for AWS-to-AWS pulls.

**`--target production` is mandatory** in the `docker build` command. The Dockerfiles' last stage is `development` (used by `docker-compose.dev.yml` for hot-reload), so without an explicit target Docker would build a broken image (no `dist/` copied) that loops failing health checks.

---

### 10. `FbookCiStack` — Continuous Integration

A single CodePipeline V2 pipeline `fbook-pipeline-ci` with two stages: Source → Build (no Deploy). Triggers on:
- Push to `main`
- Pull request events on `main` (OPEN, UPDATED) — surfaces as a status check on the PR

The Build stage runs `npm ci && npm run build` (which is `nest build`, equivalent to a TypeScript compile + bundle) for the 3 services in series, each in a subshell to keep the working directory clean:

```yaml
phases:
  build:
    commands:
      - (cd services/usuario && npm ci && npm run build)
      - (cd services/amistad && npm ci && npm run build)
      - (cd services/publicacion && npm ci && npm run build)
```

**Why a separate pipeline and not extra stages on the CD pipelines?** The CD pipelines are triggered by tags only (push of `<svc>-v*`). Adding a build stage to them would not catch errors at PR time. CI needs its own trigger filter (`pushFilter.branchesIncludes` + `pullRequestFilter`) which is independent of the tag filter.

**Why CodePipeline V2 and not a standalone CodeBuild project with a GitHub webhook?** A standalone CodeBuild project's webhook requires GitHub OAuth or a Personal Access Token — a separate auth path from the CodeStar Connection used by the CD pipelines. V2 reuses the same connection, keeping the auth surface minimal.

---

## Security Group Flow

```
Internet
  │  :80
  ▼
sg-alb
  │  :3000  (only to sg-ecs)
  ▼
sg-ecs  ←── :3000 ── sg-ecs  (inter-service via Cloud Map)
  │
ECS Fargate tasks (no public IP, unreachable from internet)
  │  (via NAT Gateway → ECR pull, CloudWatch logs)
  ▼
DynamoDB (via VPC Gateway Endpoint — stays in AWS network)
```

---

## Deployment Order

CDK resolves inter-stack dependencies automatically based on props passed between stacks.

```
FbookCdkStack (Cognito) ──────────────────────────┐  exports userPoolId
                                                  │
FbookNetworkStack (VPC, SGs)                      │
    ↓                                             │
FbookClusterStack (ECS Cluster, ECR, Cloud Map,   │
                   Log Groups)                    │
    ↓                                             │
FbookAlbStack                                     │
    ↓              ↓                  ↓           │
FbookUsersStack  FbookAmistadStack  FbookPublicationStack  ←─ consume userPoolId
    ↓              ↓                  ↓
            FbookDashboardStack (consumes target groups)

FbookPipelineStack (independent — uses imported ECR repos)
FbookCiStack       (independent — only needs source)
```

### First-time deploy

ECR repositories are created empty by CDK. ECS cannot start tasks without images — deploy the service stacks only after pushing images to ECR.

```bash
# Step 1 — infrastructure (no ECS services yet)
npx cdk deploy FbookCdkStack FbookNetworkStack FbookClusterStack FbookAlbStack --profile fbook

# Step 2 — push images (from fbook-api repo)
./push-to-ecr.sh fbook

# Step 3 — ECS services (images now available)
npx cdk deploy FbookUsersStack FbookAmistadStack FbookPublicationStack --profile fbook
```

### Subsequent deploys

```bash
npx cdk deploy --all --profile fbook
```

> **Cross-stack reference workaround.** If a `cdk deploy --all` fails with `Cannot delete export ... as it is in use by ...` (happens when a consumer drops an import while the live export is still wired), deploy the consumer stacks first to drop their imports, then re-run `--all`:
>
> ```bash
> npx cdk deploy FbookAmistadStack FbookPublicationStack --profile fbook
> npx cdk deploy --all --profile fbook
> ```

### Pipelines & Dashboard — first deploy

`FbookPipelineStack` and `FbookCiStack` both source from GitHub via a CodeStar Connection — a manual one-time AWS Console step (see `README.md → Prerequisites → CodeStar Connection`). Set the env var `FBOOK_CODESTAR_CONN_ARN` before deploying these stacks, otherwise CDK falls back to the project's hard-coded ARN which only works for the original AWS account.

`FbookDashboardStack` has no manual prerequisites. It can be deployed at any time after the service stacks exist.

### Tear Down

```bash
npx cdk destroy --all --profile fbook
```

DynamoDB tables are destroyed (`removalPolicy: DESTROY`). ECR repositories are **retained** (`removalPolicy: RETAIN`) to avoid losing images.

---

## Cost Estimate

| Resource          | Monthly cost | Notes                                                 |
| ----------------- | ------------ | ----------------------------------------------------- |
| NAT Gateway       | ~$32         | Biggest cost driver; eliminated on `cdk destroy`      |
| ALB               | ~$22         | Free tier: 750 hrs/month                              |
| ECS Fargate       | ~$0–5        | 256 CPU / 512 MB per task, 9 tasks total              |
| DynamoDB          | ~$0          | Always-free tier covers dev load                      |
| ECR               | ~$0          | Free tier: 500 MB/month per repo                      |
| CloudWatch Logs   | ~$0          | Free tier covers dev volume                           |
| CloudWatch Dashboard | $0        | First dashboard per account is free                   |
| CodePipeline      | ~$4          | $1/month per active V2 pipeline × 4 pipelines (3 CD + 1 CI) |
| CodeBuild         | ~$0–1        | $0.005/min on `general1.small`, pay-as-you-go         |
| VPC / IGW / SGs   | $0           | Always free                                           |
| Cognito           | $0           | Always free up to 50K MAUs                            |
| **Total (destroyed after each session)** | **~$0** |                                  |

CodePipeline V2 charges by **active** pipeline. A pipeline that has never executed is free; once it executes once it counts as active for the rest of the month. To minimize cost in academic environments, destroy `FbookPipelineStack` and `FbookCiStack` between sessions if pipelines are not in active use.
