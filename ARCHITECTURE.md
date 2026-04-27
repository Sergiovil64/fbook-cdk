# Fbook CDK — Architecture Documentation

## Overview

This project provisions the AWS infrastructure for **Fbook**, a Facebook-like social network clone, using AWS CDK (TypeScript). The system is composed of three independent NestJS microservices — Usuarios, Amistad, and Publicaciones — each running as a Docker container on its own EC2 instance and backed by dedicated DynamoDB tables.

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
            │  │ AZ-1a (10.0.0.0/24)                   │  │
            │  │  ┌──────────────┐  ┌───────────────┐  │  │
            │  │  │    Bastion   │  │  NAT Gateway  │  │  │
            │  │  │   t3.micro   │  │               │  │  │
            │  │  └──────────────┘  └───────────────┘  │  │
            │  │                                        │  │
            │  │ AZ-1b (10.0.1.0/24)  [HA for ALB]    │  │
            │  └────────────────────────────────────────┘  │
            │                                              │
            │  ┌──────────────────── ALB ───────────────┐  │
            │  │   (spans AZ-1a + AZ-1b, HTTP :80)      │  │
            │  │   /v1/usuarios*      → TG-Usuarios      │  │
            │  │   /v1/publicaciones* → TG-Publicacion   │  │
            │  │   /v1/comentarios*   → TG-Publicacion   │  │
            │  │   /v1/reacciones*    → TG-Publicacion   │  │
            │  │   /v1/amistades*     → TG-Amistad       │  │
            │  └──────────┬──────────────┬──────────────┘  │
            │             │              │                  │
            │  PRIVATE SUBNET (10.0.2.0/24)                │
            │  ┌──────────────────────────────────────┐    │
            │  │  EC2 Usuarios     10.0.2.10  :3000   │    │
            │  │  EC2 Amistad      10.0.2.11  :3000   │    │
            │  │  EC2 Publicacion  10.0.2.12  :3000   │    │
            │  │  (all t3.micro — Docker containers)  │    │
            │  └──────────────────────────────────────┘    │
            │                                              │
            │  VPC Gateway Endpoint  (DynamoDB — free)     │
            └──────────────────────────────────────────────┘
                    │         │         │         │
               Usuarios  Amistades Publicaciones Comentarios
               (DynamoDB)(DynamoDB) (DynamoDB)  (DynamoDB)
                                                    │
                                               Reacciones
                                               (DynamoDB)


  Cognito User Pool (OIDC / PKCE)  ←  separate managed stack
```

---

## Stack Breakdown

The infrastructure is divided into **7 independent CDK stacks**, each with a single responsibility.

### 1. `FbookCdkStack` — Authentication

Provisions a **Cognito User Pool** configured as an OIDC Authorization Server.

- Authorization Code Flow with PKCE (RFC 7636) — no client secret stored in the browser
- Exports all OIDC endpoints (issuer, JWKS URI, authorize, token, userinfo) as CloudFormation outputs
- Consumed by frontend apps and can be used by microservices to validate JWT tokens via the JWKS URI

**Why Cognito?** It is a fully managed service with a generous always-free tier (50,000 MAUs). It eliminates the need to build and maintain authentication logic, and its OIDC compliance makes it easy to integrate with any standard library.

---

### 2. `FbookNetworkStack` — VPC & Security

The networking foundation shared by all other stacks.


| Resource              | Detail                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------- |
| VPC                   | `10.0.0.0/16`, 2 Availability Zones                                                         |
| Public subnets        | 2 public `/24` subnets — host the Bastion and NAT Gateway                                   |
| Private subnets       | 2 private `/24` subnets — host the microservice EC2s                                        |
| NAT Gateway           | 1 instance in AZ-1a, shared by all private subnets                                          |
| DynamoDB VPC Endpoint | Gateway type, free — keeps DynamoDB traffic inside the AWS network                          |
| EC2 Key Pair          | **Must be created manually in AWS Console before deploying** — imported by name `fbook-key` |
| Security Groups       | `sg-alb`, `sg-bastion`, `sg-microservice`                                                   |


**Key pair requirement:** The CDK imports the key pair by name (`ec2.KeyPair.fromKeyPairName(..., 'fbook-key')`). The key must exist in AWS before `cdk deploy`. See the [README](./README.md#important--create-the-ec2-key-pair-manually-before-deploying) for creation steps.

**Why a single VPC?** Separate VPCs per microservice would require VPC Peering, significantly increasing complexity and cost without meaningful benefit at this scale.

**Why 2 AZs?** The Application Load Balancer requires at least 2 Availability Zones to operate.

**Why 1 NAT Gateway instead of 2?** A NAT Gateway per AZ (~$32/month each) is the production recommendation. For an academic environment one NAT Gateway cuts that cost in half with an acceptable trade-off.

**Why a DynamoDB VPC Gateway Endpoint?** Without it, traffic from EC2 instances to DynamoDB exits through the NAT Gateway and incurs data transfer charges. The Gateway Endpoint routes that traffic within the AWS backbone at no extra cost.

---

### 3. `FbookBastionStack` — Secure SSH Access

A single `t3.micro` EC2 instance in a public subnet that acts as the only SSH entry point into the VPC.

```
Your machine → (SSH) → Bastion (public subnet) → (SSH ProxyJump) → Microservice EC2 (private subnet)
```

Configure `~/.ssh/config` with `IdentitiesOnly yes` on both the Bastion and `10.0.2.*` entries — this is required to force the correct key for both hops.

**Why a Bastion instead of exposing EC2s directly?** Microservice EC2s have no public IP address and live in private subnets. The only way to reach port 22 on them is through the Bastion.

---

### 4. `FbookAlbStack` — Load Balancer & Routing

A single **Application Load Balancer** in the public subnets with an HTTP listener on port 80.


| Path pattern                                                | Target                      | Priority |
| ----------------------------------------------------------- | --------------------------- | -------- |
| `/v1/usuarios`*                                             | Usuarios EC2 (10.0.2.10)    | 10       |
| `/v1/publicaciones*`, `/v1/comentarios*`, `/v1/reacciones*` | Publicacion EC2 (10.0.2.12) | 20       |
| `/v1/amistades*`                                            | Amistad EC2 (10.0.2.11)     | 30       |
| anything else                                               | Fixed 404 JSON response     | —        |


**Why one ALB instead of one per microservice?** A single ALB costs ~$22/month and handles all microservices via path-based routing rules.

**Why HTTP and not HTTPS?** HTTPS requires a custom domain and an ACM certificate. For academic and testing purposes, HTTP is sufficient.

---

### 5–7. `FbookUsersStack`, `FbookAmistadStack`, `FbookPublicationStack` — Microservices

Each microservice stack follows the same pattern:

```
EC2 t3.micro (private subnet, static private IP)
  └── IAM Role → DynamoDB tables (read/write, scoped to its own tables)
  └── IAM Role → ECR (pull Docker images)
  └── Docker container → NestJS app on :3000
  └── IMDSv2 hop limit = 2 (required for container to access IAM role)
  └── ALB Target Group → registered with ALB listener rule
```

#### Static private IPs


| Microservice | IP          | Port |
| ------------ | ----------- | ---- |
| Usuarios     | `10.0.2.10` | 3000 |
| Amistad      | `10.0.2.11` | 3000 |
| Publicacion  | `10.0.2.12` | 3000 |


Static IPs allow inter-service calls using hardcoded URLs in `/opt/fbook.env` without requiring service discovery.

#### DynamoDB Table Design


| Table           | Partition Key | Stack                 |
| --------------- | ------------- | --------------------- |
| `Usuarios`      | `id` (NUMBER) | FbookUsersStack       |
| `Amistades`     | `id` (NUMBER) | FbookAmistadStack     |
| `Publicaciones` | `id` (NUMBER) | FbookPublicationStack |
| `Comentarios`   | `id` (NUMBER) | FbookPublicationStack |
| `Reacciones`    | `id` (NUMBER) | FbookPublicationStack |


---

## Security Group Flow

```
Internet
  │  :80
  ▼
sg-alb
  │  :3000  (only to sg-microservice)
  ▼
sg-microservice  ←── :22  ──  sg-bastion  ←── :22  ──  Internet
  │  :3000  (inter-service calls, intra sg-microservice)
  ▼
EC2 instances (no public IP, unreachable from internet)
  │  (via NAT Gateway → ECR pull at startup)
  ▼
DynamoDB (via VPC Gateway Endpoint — stays in AWS network)
```

---

## Deployment Order

CDK resolves inter-stack dependencies automatically. The logical order is:

```
FbookCdkStack (Cognito — independent)

FbookNetworkStack (VPC, SGs, key pair reference)
    ↓                    ↓
FbookBastionStack   FbookAlbStack
                         ↓         ↓           ↓
               FbookUsersStack  FbookAmistadStack  FbookPublicationStack
```

### Pre-deploy checklist

- AWS CLI configured (`aws sts get-caller-identity` succeeds)
- CDK bootstrapped (`npx cdk bootstrap`)
- Key pair `**fbook-key**` exists in AWS Console → EC2 → Key Pairs
- `~/.ssh/fbook-key.pem` saved locally with `chmod 400`
- Docker images pushed to ECR for all 3 microservices

### Deploy

```bash
npx cdk deploy --all
```

### SSH to a microservice (after deploy)

Add to `~/.ssh/config` (substitute real Bastion IP):

```
Host fbook-bastion
    HostName <BastionPublicIp>
    User ec2-user
    IdentityFile ~/.ssh/fbook-key.pem
    IdentitiesOnly yes

Host 10.0.2.*
    User ec2-user
    IdentityFile ~/.ssh/fbook-key.pem
    IdentitiesOnly yes
    ProxyJump fbook-bastion
```

```bash
ssh 10.0.2.10   # Usuarios
ssh 10.0.2.11   # Amistad
ssh 10.0.2.12   # Publicacion
```

### Tear Down

```bash
npx cdk destroy --all
```

All resources are destroyed including DynamoDB tables and EC2 instances. The manually-created `fbook-key` key pair is **not** deleted.

---

## Cost Estimate


| Resource                                 | Monthly cost | Notes                                            |
| ---------------------------------------- | ------------ | ------------------------------------------------ |
| NAT Gateway                              | ~$32         | Biggest cost driver; eliminated on `cdk destroy` |
| ALB                                      | ~$22         | Free tier: 750 hrs/month                         |
| EC2 t3.micro × 4                         | ~$0–20       | Free tier: 750 hrs/month total                   |
| DynamoDB                                 | ~$0          | Always-free tier covers dev load                 |
| VPC / IGW / SGs                          | $0           | Always free                                      |
| Cognito                                  | $0           | Always free up to 50K MAUs                       |
| **Total (destroyed after each session)** | **~$0**      |                                                  |


---

