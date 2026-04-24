import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly sgAlb: ec2.SecurityGroup;
  readonly sgBastion: ec2.SecurityGroup;
  readonly sgMicroservice: ec2.SecurityGroup;
  readonly keyPair: ec2.KeyPair;

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

    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Key pair (Bastion + microservicios)
    this.keyPair = new ec2.KeyPair(this, 'FbookKeyPair', {
      keyPairName: 'fbook-key',
      type: ec2.KeyPairType.RSA,
      format: ec2.KeyPairFormat.PEM,
    });

    // Security Groups
    this.sgAlb = new ec2.SecurityGroup(this, 'SgAlb', {
      vpc: this.vpc,
      description: 'ALB: allows HTTP from internet',
      allowAllOutbound: false,
    });
    this.sgAlb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP desde internet');

    this.sgBastion = new ec2.SecurityGroup(this, 'SgBastion', {
      vpc: this.vpc,
      description: 'Bastion: allows SSH from internet',
      allowAllOutbound: true,
    });
    this.sgBastion.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH desde internet');

    this.sgMicroservice = new ec2.SecurityGroup(this, 'SgMicroservice', {
      vpc: this.vpc,
      description: 'EC2 microservices: traffic from ALB and SSH from Bastion',
      allowAllOutbound: true,
    });
    this.sgMicroservice.addIngressRule(this.sgAlb, ec2.Port.tcp(8080), 'App desde ALB');
    this.sgMicroservice.addIngressRule(this.sgBastion, ec2.Port.tcp(22), 'SSH desde Bastion');

    // Allow the ALB to reach the microservices
    this.sgAlb.addEgressRule(this.sgMicroservice, ec2.Port.tcp(8080), 'To microservices');

    new cdk.CfnOutput(this, 'KeyPairSsmCommand', {
      value: [
        'aws ssm get-parameter',
        '--name /ec2/keypairs/fbook-key',
        '--with-decryption',
        '--query Parameter.Value',
        '--output text > fbook-key.pem',
        '&& chmod 400 fbook-key.pem',
      ].join(' '),
      description: 'Execute to download the private SSH key',
    });
  }
}
