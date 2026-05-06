import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly sgAlb: ec2.SecurityGroup;
  readonly sgEcs: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 2 AZs, 1 NAT Gateway
    this.vpc = new ec2.Vpc(this, 'FbookVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Gateway endpoint para DynamoDB (tráfico no sale por NAT)
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // sg-alb: internet → ALB
    this.sgAlb = new ec2.SecurityGroup(this, 'SgAlb', {
      vpc: this.vpc,
      description: 'ALB: allows HTTP from internet',
      allowAllOutbound: false,
    });
    this.sgAlb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP desde internet');

    // sg-ecs: tareas Fargate
    this.sgEcs = new ec2.SecurityGroup(this, 'SgEcs', {
      vpc: this.vpc,
      description: 'ECS Fargate tasks: traffic from ALB and inter-service (Cloud Map)',
      allowAllOutbound: true, // DynamoDB, ECR, CloudWatch, Cognito
    });
    this.sgEcs.addIngressRule(this.sgAlb, ec2.Port.tcp(3000), 'App desde ALB');
    this.sgEcs.addIngressRule(this.sgEcs, ec2.Port.tcp(3000), 'Llamadas inter-servicio (Cloud Map)');

    // Permite que el ALB llegue a las tareas ECS
    this.sgAlb.addEgressRule(this.sgEcs, ec2.Port.tcp(3000), 'To ECS tasks');
  }
}
