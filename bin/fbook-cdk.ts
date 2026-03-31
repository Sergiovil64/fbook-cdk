#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { FbookCdkStack } from '../lib/fbook-cdk-stack';

const app = new cdk.App();

new FbookCdkStack(app, 'FbookCdkStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },

  description: 'Fbook — Cognito User Pool as an OIDC Authorization Server (Authorization Code Flow + PKCE)',

  tags: {
    Project:     'fbook',
    Environment: 'dev',
    ManagedBy:   'CDK',
  },
});
