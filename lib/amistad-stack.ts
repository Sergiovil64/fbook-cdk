import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { AlbStack } from './alb-stack';

const ECR_BASE = '140858350333.dkr.ecr.us-east-1.amazonaws.com';
const IMAGE    = `${ECR_BASE}/fbook-service-amistad:latest`;

interface AmistadStackProps extends cdk.StackProps {
  network: NetworkStack;
  alb: AlbStack;
}

export class AmistadStack extends cdk.Stack {
  readonly table: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props: AmistadStackProps) {
    super(scope, id, props);

    // ── Tabla DynamoDB ────────────────────────────────────────────────────────
    this.table = new dynamodb.TableV2(this, 'AmistadTable', {
      tableName: 'Amistades',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.NUMBER },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── User Data ─────────────────────────────────────────────────────────────
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf update -y',
      'dnf install -y docker',
      'systemctl enable docker',
      'systemctl start docker',
      // Login a ECR usando el IAM role del EC2
      `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${ECR_BASE}`,
      // Pull de la imagen
      `docker pull ${IMAGE}`,
      // Variables de entorno del contenedor
      "cat > /opt/fbook.env << 'EOF'",
      'TABLE_NAME=Amistades',
      'USUARIO_SERVICE_URL=http://10.0.2.10:3000',
      'AWS_REGION=us-east-1',
      'PORT=3000',
      'EOF',
      // Arrancar contenedor
      'docker rm -f fbook-svc || true',
      `docker run -d --name fbook-svc --restart always -p 3000:3000 --env-file /opt/fbook.env ${IMAGE}`,
    );

    // ── EC2 con IP privada estática ───────────────────────────────────────────
    const privateSubnet = props.network.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets[0];

    const instance = new ec2.Instance(this, 'AmistadEc2', {
      vpc: props.network.vpc,
      vpcSubnets: { subnets: [privateSubnet] },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: props.network.sgMicroservice,
      keyPair: props.network.keyPair,
      privateIpAddress: '10.0.2.11',
      userData,
    });

    // Hop limit 2: necesario para que el contenedor Docker acceda al IAM role via IMDSv2
    (instance.node.defaultChild as ec2.CfnInstance).metadataOptions = {
      httpTokens: 'required',
      httpPutResponseHopLimit: 2,
    };

    // Permisos DynamoDB y ECR
    this.table.grantReadWriteData(instance.role);
    instance.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
    );

    // ── ALB Target Group + Listener Rule ──────────────────────────────────────
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'AmistadTg', {
      vpc: props.network.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new targets.InstanceTarget(instance, 3000)],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    new elbv2.ApplicationListenerRule(this, 'AmistadRule', {
      listener: props.alb.listener,
      priority: 30,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/v1/amistades', '/v1/amistades/*']),
      ],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AmistadInstanceId', {
      value: instance.instanceId,
      description: 'ID de la instancia EC2 (para SSH via Bastion)',
    });

    new cdk.CfnOutput(this, 'AmistadPrivateIp', {
      value: instance.instancePrivateIp,
    });

    new cdk.CfnOutput(this, 'AmistadTableName', {
      value: this.table.tableName,
    });
  }
}
