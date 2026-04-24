# Fbook CDK — Architecture Documentation

## Overview

This project provisions the AWS infrastructure for **Fbook**, a Facebook-like social network clone, using AWS CDK (TypeScript). The system is composed of three independent microservices — Publications, Comments, and Friendships — each running on its own EC2 instance and backed by a dedicated DynamoDB table.

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
            │  │  │   t2.micro   │  │               │  │  │
            │  │  └──────────────┘  └───────────────┘  │  │
            │  │                                        │  │
            │  │ AZ-1b (10.0.1.0/24)  [HA for ALB]    │  │
            │  └────────────────────────────────────────┘  │
            │                                              │
            │  ┌──────────────── ALB ───────────────────┐  │
            │  │   (spans AZ-1a + AZ-1b, HTTP :80)      │  │
            │  │   /api/publications  →  TG-Publication  │  │
            │  │   /api/comments      →  TG-Comment      │  │
            │  │   /api/friendships   →  TG-Friendship   │  │
            │  └──────────┬─────────────┬───────────────┘  │
            │             │             │          │        │
            │  PRIVATE SUBNETS                             │
            │  ┌──────────────────────────────────────┐    │
            │  │ AZ-1a (10.0.10.0/24)                 │    │
            │  │  ┌──────────────────────────────┐    │    │
            │  │  │   EC2 Publication  t2.micro  │    │    │
            │  │  │         :8080                │    │    │
            │  │  └──────────────────────────────┘    │    │
            │  │                                      │    │
            │  │ AZ-1b (10.0.11.0/24)                 │    │
            │  │  ┌──────────────┐  ┌──────────────┐  │    │
            │  │  │ EC2 Comment  │  │ EC2 Friendship│  │    │
            │  │  │   t2.micro   │  │   t2.micro   │  │    │
            │  │  │    :8080     │  │    :8080     │  │    │
            │  │  └──────────────┘  └──────────────┘  │    │
            │  └──────────────────────────────────────┘    │
            │                                              │
            │  VPC Gateway Endpoint  (DynamoDB — free)     │
            └──────────────────────────────────────────────┘
                    │              │              │
             fbook-posts    fbook-comments  fbook-friendships
              (DynamoDB)      (DynamoDB)      (DynamoDB)


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


| Resource              | Detail                                                                      |
| --------------------- | --------------------------------------------------------------------------- |
| VPC                   | `10.0.0.0/16`, 2 Availability Zones                                         |
| Public subnets        | 2 public `/24` subnets — host the Bastion and NAT Gateway                    |
| Private subnets       | 2 private `/24` subnets — host the microservice EC2s                         |
| NAT Gateway           | 1 instance in AZ-1a, shared by all private subnets                          |
| DynamoDB VPC Endpoint | Gateway type, free — keeps DynamoDB traffic inside the AWS network          |
| EC2 Key Pair          | Single RSA key for all instances; private key stored in SSM Parameter Store |
| Security Groups       | `sg-alb`, `sg-bastion`, `sg-microservice`                                   |


The diagram shows representative `/24` subnet ranges for readability. In the CDK implementation, subnet CIDRs are assigned automatically from the `10.0.0.0/16` VPC using `cidrMask: 24`.

**Why a single VPC?** Separate VPCs per microservice would require VPC Peering, significantly increasing complexity and cost without meaningful benefit at this scale. A single VPC with well-defined security groups provides the same isolation guarantees.

**Why 2 AZs?** The Application Load Balancer requires at least 2 Availability Zones to operate. This also lays the groundwork for high availability if the project scales.

**Why 1 NAT Gateway instead of 2?** A NAT Gateway per AZ (~$32/month each) is the production recommendation for high availability. For an academic environment where stacks are destroyed after testing, one NAT Gateway cuts that cost in half with an acceptable trade-off: if AZ-1a fails, private subnets in AZ-1b lose outbound internet access.

**Why a DynamoDB VPC Gateway Endpoint?** Without it, traffic from EC2 instances to DynamoDB exits through the NAT Gateway and incurs data transfer charges. The Gateway Endpoint routes that traffic within the AWS backbone at no extra cost.

---

### 3. `FbookBastionStack` — Secure SSH Access

A single `t2.micro` EC2 instance in a public subnet that acts as the only SSH entry point into the VPC.

```
Your machine  →(SSH)→  Bastion (public subnet)  →(SSH ProxyJump)→  Microservice EC2 (private subnet)
```

**Why a Bastion instead of exposing EC2s directly?** Microservice EC2s have no public IP address and live in private subnets. The only way to reach port 22 on them is through the Bastion. This minimizes the attack surface: only one machine is exposed to the internet on port 22, and only for SSH.

**Why not AWS Systems Manager Session Manager?** SSM Session Manager is the modern, production-grade alternative (no open ports, audited sessions, no EC2 overhead). However, it requires either internet access from the EC2 (via NAT) or a VPC Interface Endpoint for SSM (~$7/month). The Bastion is simpler to understand and set up in an academic context.

---

### 4. `FbookAlbStack` — Load Balancer & Routing

A single **Application Load Balancer** in the public subnets with an HTTP listener on port 80.

Path-based routing rules distribute traffic to each microservice:


| Path pattern                                 | Target                        |
| -------------------------------------------- | ----------------------------- |
| `/api/publications` or `/api/publications/*` | Publication EC2 (priority 10) |
| `/api/comments` or `/api/comments/*`         | Comment EC2 (priority 20)     |
| `/api/friendships` or `/api/friendships/*`   | Friendship EC2 (priority 30)  |
| anything else                                | Fixed 404 JSON response       |


**Why one ALB instead of one per microservice?** A single ALB costs ~$22/month and handles all three microservices via path-based routing rules. Three separate ALBs would cost ~$66/month for no additional benefit at this scale.

**Why ALB and not API Gateway?** API Gateway offers native Cognito JWT authorization, rate limiting, and caching — all valuable in production. However, connecting API Gateway to EC2 instances in private subnets requires a **VPC Link** (~$7/month, not in the free tier), making it more expensive for an academic setup. With ALB, JWT validation is the responsibility of each microservice (a single shared middleware against the Cognito JWKS URI is sufficient). API Gateway becomes the better choice when switching to Lambda-based microservices.

**Why HTTP and not HTTPS?** HTTPS requires a custom domain registered in Route 53 and a certificate from ACM. For academic and testing purposes, HTTP on the ALB DNS name is sufficient. Enabling HTTPS later only requires adding an ACM certificate and changing the listener port to 443.

---

### 5–7. `FbookPublicationStack`, `FbookCommentStack`, `FbookFriendshipStack` — Microservices

Each microservice stack follows the same pattern and is fully independent:

```
EC2 t2.micro (private subnet)
  └── IAM Role  →  DynamoDB table (read/write, scoped to its own table only)
  └── systemd   →  placeholder HTTP server on :8080
  └── ALB Target Group  →  registers with ALB listener rule
```

#### DynamoDB Table Design


| Table               | Partition Key | Sort Key    | Notes                                                |
| ------------------- | ------------- | ----------- | ---------------------------------------------------- |
| `fbook-posts`       | `userId`      | `postId`    | GSI on `postId` for direct post lookup               |
| `fbook-comments`    | `postId`      | `commentId` | Efficiently lists all comments for a post            |
| `fbook-friendships` | `userId`      | `friendId`  | `status` attribute: `PENDING`, `ACCEPTED`, `BLOCKED` |


**Why DynamoDB?** It is serverless, scales to zero, and has a generous always-free tier (25 GB, 25 WCU, 25 RCU). It pairs naturally with microservices because each service owns its own table, there are no shared schemas, and there is no database server to manage or secure.

**Why on-demand billing?** On-demand (pay-per-request) simplifies capacity planning and is effectively free under development/test load. Provisioned mode (25 WCU/RCU free tier) is the better choice only if traffic patterns are predictable and stable.

**Why `removalPolicy: DESTROY`?** Since this environment is torn down after each test session (`cdk destroy --all`), keeping tables around would leave orphaned resources. `DESTROY` ensures a clean teardown.

**Why `t2.micro`?** It is the free-tier-eligible instance type (750 hours/month combined across all instances). Three instances running 8 hours/day stay within the free-tier budget. For production, `t3.small` or larger would be appropriate.

**Why each EC2 has its own IAM Role scoped to one table?** This follows the principle of least privilege. The Publication EC2 can only read/write `fbook-posts`; it cannot touch `fbook-comments` or `fbook-friendships`. A compromised microservice cannot affect the data of the others.

**Why a placeholder HTTP server?** The EC2 instances are ready to receive a real microservice deployment. The Python placeholder (running as a `systemd` service) keeps the ALB health checks passing until the actual application is deployed, avoiding unhealthy target group errors.

---

## Security Group Flow

```
Internet
  │  :80
  ▼
sg-alb
  │  :8080  (only to sg-microservice)
  ▼
sg-microservice  ←── :22  ──  sg-bastion  ←── :22  ──  Internet
  │
  ▼
EC2 instances (no public IP, unreachable from internet)
  │  (via NAT Gateway)
  ▼
DynamoDB (via VPC Gateway Endpoint — stays in AWS network)
```

No EC2 microservice is directly reachable from the internet. Traffic can only reach them through two paths:

1. **Port 8080** — from the ALB (forwarding user HTTP requests)
2. **Port 22** — from the Bastion (operator SSH access)

---

## Deployment Order

CDK resolves inter-stack dependencies automatically based on the props passed between stacks. Cognito has no infrastructure dependency on the VPC and may be deployed independently. The logical dependency order for the networked resources is:

```
FbookCdkStack (Cognito)  [independent authentication stack]

FbookNetworkStack (VPC, SGs, Key Pair)
    ↓              ↓
FbookBastionStack  FbookAlbStack
                       ↓          ↓          ↓
              FbookPublicationStack  FbookCommentStack  FbookFriendshipStack
```

### Deploy

```bash
# Bootstrap the account/region once
cdk bootstrap

# Deploy all stacks
cdk deploy --all

# Retrieve the SSH private key after deployment
aws ssm get-parameter \
  --name /ec2/keypairs/fbook-key \
  --with-decryption \
  --query Parameter.Value \
  --output text > fbook-key.pem
chmod 400 fbook-key.pem

# SSH to a microservice EC2 via Bastion (jump host)
ssh -i fbook-key.pem -J ec2-user@<BastionPublicIp> ec2-user@<PrivateEc2Ip>
```

### Tear Down

```bash
npx cdk destroy --all
```

All resources are destroyed, including DynamoDB tables (`removalPolicy: DESTROY`), key pairs, NAT Gateways, and EC2 instances. No orphaned resources remain.

---

## Cost Estimate


| Resource                                 | Monthly cost        | Notes                                                         |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------- |
| NAT Gateway                              | ~$32                | Biggest cost driver; eliminated on `cdk destroy`              |
| ALB                                      | ~$22                | Free tier: 750 hrs/month                                      |
| EC2 t2.micro × 3                         | ~$0–17              | Free tier: 750 hrs/month total across eligible Linux instances |
| Bastion t2.micro                         | Shares free tier    | Counts against the same 750 hrs/month pool                     |
| DynamoDB                                 | ~$0                 | Always-free tier covers dev load                              |
| VPC / IGW / SGs                          | $0                  | Always free                                                   |
| ACM / Cognito                            | $0                  | Always free                                                   |
| **Total (8 hrs/day usage)**              | **~$54/month**      |                                                               |
| **Total (destroyed after each session)** | **~$0**             |                                                               |


---

## Future Improvements


| Area              | Recommendation                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| HTTPS             | Add ACM certificate + Route 53 domain, change ALB listener to :443                                      |
| Auth at the edge  | Move JWT validation to the ALB (Cognito OIDC auth action) or add an API Gateway + VPC Link              |
| High availability | Add a second NAT Gateway in AZ-1b; place one EC2 per microservice in each AZ with an Auto Scaling Group |
| Observability     | Add CloudWatch Log Groups, metric alarms, and X-Ray tracing to each EC2                                 |
| CI/CD             | Add CodePipeline + CodeDeploy to automate microservice deployments to the EC2 instances                 |
| Instance type     | Upgrade from `t2.micro` to `t3.small` for production workloads                                          |


