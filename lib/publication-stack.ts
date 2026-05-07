import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { AlbStack } from './alb-stack';
import { ClusterStack } from './cluster-stack';

interface PublicationStackProps extends cdk.StackProps {
  network: NetworkStack;
  alb: AlbStack;
  cluster: ClusterStack;
  cognitoUserPoolId: string;
}

export class PublicationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PublicationStackProps) {
    super(scope, id, props);

    // DynamoDB
    const tablePublicaciones = new dynamodb.TableV2(this, 'PublicacionesTable', {
      tableName: 'Publicaciones',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const tableComentarios = new dynamodb.TableV2(this, 'ComentariosTable', {
      tableName: 'Comentarios',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const tableReacciones = new dynamodb.TableV2(this, 'ReaccionesTable', {
      tableName: 'Reacciones',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task Role — acceso exclusivo a Publicaciones + Comentarios + Reacciones
    const taskRole = new iam.Role(this, 'PublicacionTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
        'dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:Query',
        'dynamodb:DescribeTable', 'dynamodb:CreateTable',
      ],
      resources: [
        'arn:aws:dynamodb:us-east-1:*:table/Publicaciones',
        'arn:aws:dynamodb:us-east-1:*:table/Comentarios',
        'arn:aws:dynamodb:us-east-1:*:table/Reacciones',
      ],
    }));

    // Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'PublicacionTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: props.cluster.executionRole,
      taskRole,
    });

    const container = taskDef.addContainer('publicacion', {
      image: ecs.ContainerImage.fromEcrRepository(props.cluster.repoPublicacion, 'latest'),
      environment: {
        PORT: '3000',
        AWS_REGION: 'us-east-1',
        TABLE_NAME: 'Publicaciones',
        TABLE_COMENTARIOS: 'Comentarios',
        TABLE_REACCIONES: 'Reacciones',
        USUARIO_SERVICE_URL: 'http://usuario.fbook.local:3000',
        PUBLICACION_SERVICE_URL: 'http://publicacion.fbook.local:3000',
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ecs',
        logGroup: props.cluster.logGroupPublicacion,
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
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'PublicacionTg', {
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

    // ECS Service con Cloud Map 
    const service = new ecs.FargateService(this, 'PublicacionService', {
      serviceName: 'fbook-service-publicacion',
      cluster: props.cluster.cluster,
      taskDefinition: taskDef,
      desiredCount: 3,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.network.sgEcs],
      assignPublicIp: false,
      cloudMapOptions: {
        name: 'publicacion',
        cloudMapNamespace: props.cluster.namespace,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    targetGroup.addTarget(service.loadBalancerTarget({
      containerName: 'publicacion',
      containerPort: 3000,
    }));

    //  Listener Rules (prioridades 3, 4, 5) 
    new elbv2.ApplicationListenerRule(this, 'PublicacionRule', {
      listener: props.alb.listener,
      priority: 30,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/v1/publicaciones*'])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    new elbv2.ApplicationListenerRule(this, 'ComentariosRule', {
      listener: props.alb.listener,
      priority: 40,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/v1/comentarios*'])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    new elbv2.ApplicationListenerRule(this, 'ReaccionesRule', {
      listener: props.alb.listener,
      priority: 50,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/v1/reacciones*'])],
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
    new cdk.CfnOutput(this, 'PublicacionesTableName', { value: tablePublicaciones.tableName });
    new cdk.CfnOutput(this, 'ComentariosTableName',   { value: tableComentarios.tableName });
    new cdk.CfnOutput(this, 'ReaccionesTableName',    { value: tableReacciones.tableName });
    new cdk.CfnOutput(this, 'PublicacionServiceName', {
      value: service.serviceName,
      description: 'ECS Service name - used by CI/CD for force-new-deployment',
      exportName: 'FbookPublicacionServiceName',
    });
  }
}
