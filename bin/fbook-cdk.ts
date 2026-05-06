#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { FbookCdkStack }    from '../lib/fbook-cdk-stack';
import { NetworkStack }     from '../lib/network-stack';
import { ClusterStack }     from '../lib/cluster-stack';
import { AlbStack }         from '../lib/alb-stack';
import { UsersStack }       from '../lib/users-stack';
import { AmistadStack }     from '../lib/amistad-stack';
import { PublicationStack } from '../lib/publication-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const tags = {
  Project:     'fbook',
  Environment: 'dev',
  ManagedBy:   'CDK',
};

// ── Stack 1: Cognito User Pool (OIDC) ─────────────────────────────────────────
new FbookCdkStack(app, 'FbookCdkStack', {
  env,
  description: 'Fbook — Cognito User Pool as an OIDC Authorization Server (Authorization Code Flow + PKCE)',
  tags,
});

// ── Stack 2: Red (VPC, subnets, NAT, SGs) ────────────────────────────────────
const network = new NetworkStack(app, 'FbookNetworkStack', {
  env,
  description: 'Fbook — VPC, subnets públicas/privadas, NAT Gateway, security groups (ALB + ECS)',
  tags,
});

// ── Stack 3: ECS Cluster + Cloud Map + ECR repos + Task Execution Role ────────
const cluster = new ClusterStack(app, 'FbookClusterStack', {
  env,
  description: 'Fbook — ECS Cluster Fargate, Cloud Map fbook.local, repositorios ECR, Task Execution Role',
  tags,
  network,
});

// ── Stack 4: Load Balancer ────────────────────────────────────────────────────
const alb = new AlbStack(app, 'FbookAlbStack', {
  env,
  description: 'Fbook — Application Load Balancer con path routing hacia microservicios ECS',
  tags,
  network,
});

// ── Stacks 5-7: Microservicios (ECS Fargate + DynamoDB) ──────────────────────
new UsersStack(app, 'FbookUsersStack', {
  env,
  description: 'Fbook — Microservicio Usuarios: ECS Fargate + DynamoDB Usuarios',
  tags,
  network,
  alb,
  cluster,
});

new AmistadStack(app, 'FbookAmistadStack', {
  env,
  description: 'Fbook — Microservicio Amistad: ECS Fargate + DynamoDB Amistades',
  tags,
  network,
  alb,
  cluster,
});

new PublicationStack(app, 'FbookPublicationStack', {
  env,
  description: 'Fbook — Microservicio Publicaciones: ECS Fargate + DynamoDB Publicaciones/Comentarios/Reacciones',
  tags,
  network,
  alb,
  cluster,
});
