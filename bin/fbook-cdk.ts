#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { FbookCdkStack }    from '../lib/fbook-cdk-stack';
import { NetworkStack }     from '../lib/network-stack';
import { BastionStack }     from '../lib/bastion-stack';
import { AlbStack }         from '../lib/alb-stack';
import { UsersStack }       from '../lib/users-stack';
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

// ── Stack 1: Autenticación (existente) ────────────────────────────────────────
new FbookCdkStack(app, 'FbookCdkStack', {
  env,
  description: 'Fbook — Cognito User Pool as an OIDC Authorization Server (Authorization Code Flow + PKCE)',
  tags,
});

// ── Stack 2: Red (VPC, subnets, NAT, SGs, key pair) ──────────────────────────
const network = new NetworkStack(app, 'FbookNetworkStack', {
  env,
  description: 'Fbook — VPC, subnets públicas/privadas, NAT Gateway, security groups',
  tags,
});

// ── Stack 3: Bastion (acceso SSH a EC2 privados) ──────────────────────────────
new BastionStack(app, 'FbookBastionStack', {
  env,
  description: 'Fbook — Bastion Host para acceso SSH a microservicios en subnet privada',
  tags,
  network,
});

// ── Stack 4: Load Balancer ────────────────────────────────────────────────────
const alb = new AlbStack(app, 'FbookAlbStack', {
  env,
  description: 'Fbook — Application Load Balancer con path routing hacia microservicios',
  tags,
  network,
});

// ── Stacks 5-6: Microservicios (EC2 t2.micro + DynamoDB) ─────────────────────
new UsersStack(app, 'FbookUsersStack', {
  env,
  description: 'Fbook — Microservicio Usuarios: EC2 + DynamoDB Usuarios (IP: 10.0.2.10)',
  tags,
  network,
  alb,
});

new PublicationStack(app, 'FbookPublicationStack', {
  env,
  description: 'Fbook — Microservicio Publicaciones: EC2 + DynamoDB Publicaciones/Comentarios/Reacciones (IP: 10.0.2.12)',
  tags,
  network,
  alb,
});
