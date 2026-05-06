import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ClusterStack } from './cluster-stack';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { AlbStack } from './alb-stack';

interface AmistadStackProps extends cdk.StackProps {
  network: NetworkStack;
  alb: AlbStack;
  cluster: ClusterStack;
}

export class AmistadStack extends cdk.Stack {
  readonly table: dynamodb.TableV2;
  readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: AmistadStackProps) {
    super(scope, id, props);

    // DynamoDB
    const table = new dynamodb.TableV2(this, 'AmistadTable', {
      tableName: 'Amistades',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.NUMBER },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task Role — acceso exclusivo a tabla Amistades
    const taskRole = new iam.Role(this, 'AmistadTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
        'dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:Query',
        'dynamodb:DescribeTable', 'dynamodb:CreateTable',
      ],
      resources: [`arn:aws:dynamodb:us-east-1:*:table/Amistades`],
    }));

    // Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'AmistadTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: props.cluster.executionRole,
      taskRole,
    });

    const container = taskDef.addContainer('amistad', {
      image: ecs.ContainerImage.fromEcrRepository(props.cluster.repoAmistad, 'latest'),
      environment: {
        PORT: '3000',
        AWS_REGION: 'us-east-1',
        TABLE_NAME: 'Amistades',
        USUARIO_SERVICE_URL: 'http://usuario.fbook.local:3000',
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ecs',
        logGroup: props.cluster.logGroupAmistad,
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "require(\'http\').get(\'http://localhost:3000/health\', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on(\'error\', () => process.exit(1))"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });
    container.addPortMappings({ containerPort: 3000 });

    // Target Group (tipo IP para Fargate)
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'AmistadTg', {
      vpc: props.network.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    this.targetGroup = targetGroup;

    // ECS Service con Cloud Map
    const service = new ecs.FargateService(this, 'AmistadService', {
      serviceName: 'fbook-service-amistad',
      cluster: props.cluster.cluster,
      taskDefinition: taskDef,
      desiredCount: 3,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.network.sgEcs],
      assignPublicIp: false,
      cloudMapOptions: {
        name: 'amistad',
        cloudMapNamespace: props.cluster.namespace,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    targetGroup.addTarget(service.loadBalancerTarget({
      containerName: 'amistad',
      containerPort: 3000,
    }));

    // Listener Rule (prioridad 2)
    new elbv2.ApplicationListenerRule(this, 'AmistadRule', {
      listener: props.alb.listener,
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/v1/amistades*'])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    // Auto Scaling (min 3 / max 6, CPU + Memoria 70%)
    const scaling = service.autoScaleTaskCount({ minCapacity: 3, maxCapacity: 6 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.seconds(120),
    });
    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 70,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.seconds(120),
    });

    // Outputs
    new cdk.CfnOutput(this, 'AmistadTableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'AmistadServiceName', {
      value: service.serviceName,
      description: 'ECS Service name - used by CI/CD for force-new-deployment',
      exportName: 'FbookAmistadServiceName',
    });
  }
}
