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
```

---

## Stack Breakdown

The infrastructure is divided into **7 independent CDK stacks**, each with a single responsibility.

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
| `Usuarios`      | `id` (NUMBER) | usuario only            |
| `Amistades`     | `id` (NUMBER) | amistad only            |
| `Publicaciones` | `id` (NUMBER) | publicacion only        |
| `Comentarios`   | `id` (NUMBER) | publicacion only        |
| `Reacciones`    | `id` (NUMBER) | publicacion only        |

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
FbookCdkStack (Cognito — independent)

FbookNetworkStack (VPC, SGs)
    ↓
FbookClusterStack (ECS Cluster, ECR, Cloud Map, Log Groups)
    ↓
FbookAlbStack
    ↓              ↓                  ↓
FbookUsersStack  FbookAmistadStack  FbookPublicationStack
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

### Tear Down

```bash
npx cdk destroy --all --profile fbook
```

DynamoDB tables are destroyed (`removalPolicy: DESTROY`). ECR repositories are **retained** (`removalPolicy: RETAIN`) to avoid losing images.

---

## Cost Estimate

| Resource          | Monthly cost | Notes                                            |
| ----------------- | ------------ | ------------------------------------------------ |
| NAT Gateway       | ~$32         | Biggest cost driver; eliminated on `cdk destroy` |
| ALB               | ~$22         | Free tier: 750 hrs/month                         |
| ECS Fargate       | ~$0–5        | 256 CPU / 512 MB per task, 9 tasks total         |
| DynamoDB          | ~$0          | Always-free tier covers dev load                 |
| ECR               | ~$0          | Free tier: 500 MB/month per repo                 |
| CloudWatch Logs   | ~$0          | Free tier covers dev volume                      |
| VPC / IGW / SGs   | $0           | Always free                                      |
| Cognito           | $0           | Always free up to 50K MAUs                       |
| **Total (destroyed after each session)** | **~$0** |                             |
