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
   Task Role usuario     → table Usuarios
   Task Role amistad     → table Amistades
   Task Role publicacion → tables Publicaciones, Comentarios, Reacciones

CloudWatch Logs
   /ecs/fbook-usuario
   /ecs/fbook-amistad
   /ecs/fbook-publicacion

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

---

## Prerequisites

| Tool | Install / notes |
|------|-----------------|
| Node.js ≥ 18 | https://nodejs.org |
| AWS CLI ≥ 2 | configured with profile `fbook` |
| AWS CDK CLI 2.x | `npm install -g aws-cdk` |

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

### Key outputs

| Output | Description |
|--------|-------------|
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
