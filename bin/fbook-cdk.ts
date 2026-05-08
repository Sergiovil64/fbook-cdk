#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { FbookCdkStack }    from '../lib/fbook-cdk-stack';
import { NetworkStack }     from '../lib/network-stack';
import { ClusterStack }     from '../lib/cluster-stack';
import { AlbStack }         from '../lib/alb-stack';
import { UsersStack }       from '../lib/users-stack';
import { AmistadStack }     from '../lib/amistad-stack';
import { PublicationStack } from '../lib/publication-stack';
import { DashboardStack }   from '../lib/dashboard-stack';
import { PipelineStack }    from '../lib/pipeline-stack';
import { CiStack }          from '../lib/ci-stack';

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
const cognito = new FbookCdkStack(app, 'FbookCdkStack', {
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
const users = new UsersStack(app, 'FbookUsersStack', {
  env,
  description: 'Fbook — Microservicio Usuarios: ECS Fargate + DynamoDB Usuarios',
  tags,
  network,
  alb,
  cluster,
  cognitoUserPoolId: cognito.userPoolId,
});

const amistad = new AmistadStack(app, 'FbookAmistadStack', {
  env,
  description: 'Fbook — Microservicio Amistad: ECS Fargate + DynamoDB Amistades',
  tags,
  network,
  alb,
  cluster,
  cognitoUserPoolId: cognito.userPoolId,
});

const publication = new PublicationStack(app, 'FbookPublicationStack', {
  env,
  description: 'Fbook — Microservicio Publicaciones: ECS Fargate + DynamoDB Publicaciones/Comentarios/Reacciones',
  tags,
  network,
  alb,
  cluster,
  cognitoUserPoolId: cognito.userPoolId,
});

// ── Stack 8: CloudWatch Dashboard ─────────────────────────────────────────────
new DashboardStack(app, 'FbookDashboardStack', {
  env,
  description: 'Fbook — CloudWatch Dashboard único con logs, métricas EMF, EC2 y ALB',
  tags,
  alb,
  users,
  amistad,
  publication,
});

// ── Stack 9: CI/CD Pipeline (CodePipeline + CodeBuild + EventBridge) ──────────
// Connection ARN viene de la CodeStar Connection creada manualmente (Fase 0).
// Pasarlo como env var: FBOOK_CODESTAR_CONN_ARN
const codestarConnectionArn = process.env.FBOOK_CODESTAR_CONN_ARN
  ?? 'arn:aws:codeconnections:us-east-1:140858350333:connection/36d58fd1-a0de-4fe9-8d91-05ab66e09fd8';

new PipelineStack(app, 'FbookPipelineStack', {
  env,
  description: 'Fbook — CI/CD: 3 CodePipeline (uno por microservicio) disparados por tags git',
  tags,
  codestarConnectionArn,
  githubOwner: 'Sergiovil64',
  githubRepo: 'fbook-api',
  githubBranch: 'main',
});

// ── Stack 10: CI (lint/type-check + build de los 3 services) ──────────────────
// Pipeline V2 separado del CD: dispara en push a main y en PRs (open/updated).
// Usa la misma CodeStar Connection. Sin stage Deploy.
new CiStack(app, 'FbookCiStack', {
  env,
  description: 'Fbook — CI: type-check + build de los 3 microservicios en push a main y PRs',
  tags,
  codestarConnectionArn,
  githubOwner: 'Sergiovil64',
  githubRepo: 'fbook-api',
  githubBranch: 'main',
});
