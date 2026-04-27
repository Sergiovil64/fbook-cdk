# fbook-cdk

AWS CDK (TypeScript) infrastructure for **Fbook** — a social network built on microservices. Provisions a full VPC with three NestJS microservices running in Docker on EC2, fronted by an Application Load Balancer and backed by DynamoDB.

---

## Architecture overview

```
Internet
   │  :80
   ▼
Application Load Balancer  (public subnets, HTTP)
   │  /v1/usuarios*      → EC2 10.0.2.10  (fbook-service-usuario)
   │  /v1/publicaciones* → EC2 10.0.2.12  (fbook-service-publicacion)
   │  /v1/comentarios*   → EC2 10.0.2.12  (fbook-service-publicacion)
   │  /v1/reacciones*    → EC2 10.0.2.12  (fbook-service-publicacion)
   │  /v1/amistades*     → EC2 10.0.2.11  (fbook-service-amistad)
   ▼
Private subnets (10.0.2.0/24)   ←── Bastion SSH jump host (public)
   EC2 t3.micro × 3  (Docker containers, port 3000)
   IAM Role per instance → DynamoDB (scoped to its own tables)
   IAM Role → ECR (pull images at startup)

DynamoDB tables (on-demand):
   Usuarios · Amistades · Publicaciones · Comentarios · Reacciones

Cognito User Pool  (separate stack — OIDC/PKCE auth server)
```

---

## Stacks

| Stack | Description |
|-------|-------------|
| `FbookCdkStack` | Cognito User Pool (OIDC Authorization Server) |
| `FbookNetworkStack` | VPC, subnets, NAT Gateway, security groups, key pair reference |
| `FbookBastionStack` | Bastion EC2 (SSH jump host into private subnets) |
| `FbookAlbStack` | Application Load Balancer with path-based routing |
| `FbookUsersStack` | EC2 `10.0.2.10` + DynamoDB `Usuarios` |
| `FbookAmistadStack` | EC2 `10.0.2.11` + DynamoDB `Amistades` |
| `FbookPublicationStack` | EC2 `10.0.2.12` + DynamoDB `Publicaciones`, `Comentarios`, `Reacciones` |

---

## Prerequisites

| Tool | Install / notes |
|------|-----------------|
| Node.js ≥ 18 | https://nodejs.org |
| AWS CLI ≥ 2 | `aws configure` with your credentials |
| AWS CDK CLI 2.x | `npm install -g aws-cdk` |
| Docker | Required only for building and pushing images (see fbook-api) |

---

## IMPORTANT — Create the EC2 key pair manually before deploying

The CDK stacks reference a key pair named **`fbook-key`** that **must exist in AWS before the first deploy**. CDK does not create it — it imports it by name.

1. Go to **AWS Console → EC2 → Key Pairs → Create key pair**
2. Name: **`fbook-key`**
3. Format: `.pem` (for OpenSSH)
4. Download and save the file as `~/.ssh/fbook-key.pem`
5. Restrict permissions:

```bash
chmod 400 ~/.ssh/fbook-key.pem
```

If this key does not exist when you run `cdk deploy`, CloudFormation will fail when trying to attach it to the EC2 instances.

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
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=us-east-1
```

```powershell
# PowerShell
$env:CDK_DEFAULT_ACCOUNT = (aws sts get-caller-identity --query Account --output text)
$env:CDK_DEFAULT_REGION  = "us-east-1"
```

Bootstrap CDK (first time only per account/region):

```bash
npx cdk bootstrap
```

---

## Deploy

```bash
npx cdk deploy --all
```

CloudFormation prints all outputs at the end. Key outputs:

| Output | Description |
|--------|-------------|
| `FbookAlbStack.AlbDnsName` | Public DNS of the ALB — use this to call the API |
| `FbookBastionStack.BastionPublicIp` | Public IP of the Bastion |
| `FbookUsersStack.UsuarioPrivateIp` | `10.0.2.10` |
| `FbookAmistadStack.AmistadPrivateIp` | `10.0.2.11` |
| `FbookPublicationStack.PublicacionPrivateIp` | `10.0.2.12` |

---

## SSH access

Configure `~/.ssh/config` once (substitute the actual Bastion IP):

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

Then connect directly to any microservice EC2:

```bash
ssh 10.0.2.10   # Usuarios
ssh 10.0.2.11   # Amistad
ssh 10.0.2.12   # Publicacion
```

---

## Update a microservice (after pushing a new Docker image)

After pushing a new image to ECR, SSH into the relevant EC2 and run:

```bash
ECR_BASE=140858350333.dkr.ecr.us-east-1.amazonaws.com
IMAGE=$ECR_BASE/fbook-service-usuario:latest   # change as needed

aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin $ECR_BASE

docker pull $IMAGE
docker rm -f fbook-svc
docker run -d --name fbook-svc --restart always -p 3000:3000 \
  --env-file /opt/fbook.env $IMAGE
```

Containers use the **EC2 IAM Role** for DynamoDB and ECR access — no `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` needed.

---

## Tear down

```bash
npx cdk destroy --all
```

All resources are destroyed including DynamoDB tables (`removalPolicy: DESTROY`), NAT Gateways, and EC2 instances. The `fbook-key` key pair in AWS is **not** deleted (it was created manually).

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
