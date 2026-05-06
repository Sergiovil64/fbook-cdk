import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';

interface ClusterStackProps extends cdk.StackProps {
  network: NetworkStack;
}

export class ClusterStack extends cdk.Stack {
  readonly cluster: ecs.Cluster;
  readonly namespace: servicediscovery.PrivateDnsNamespace;
  readonly executionRole: iam.Role;
  readonly repoUsuario: ecr.Repository;
  readonly repoAmistad: ecr.Repository;
  readonly repoPublicacion: ecr.Repository;
  readonly logGroupUsuario: logs.LogGroup;
  readonly logGroupAmistad: logs.LogGroup;
  readonly logGroupPublicacion: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);

    // ECR Repositories
    // RETAIN: las imágenes no se borran si se destruye el stack
    this.repoUsuario = new ecr.Repository(this, 'RepoUsuario', {
      repositoryName: 'fbook-service-usuario',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.repoAmistad = new ecr.Repository(this, 'RepoAmistad', {
      repositoryName: 'fbook-service-amistad',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.repoPublicacion = new ecr.Repository(this, 'RepoPublicacion', {
      repositoryName: 'fbook-service-publicacion',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // CloudWatch Log Groups — aquí para evitar dependencia circular con los service stacks
    this.logGroupUsuario = new logs.LogGroup(this, 'LogGroupUsuario', {
      logGroupName: '/ecs/fbook-usuario',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.logGroupAmistad = new logs.LogGroup(this, 'LogGroupAmistad', {
      logGroupName: '/ecs/fbook-amistad',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.logGroupPublicacion = new logs.LogGroup(this, 'LogGroupPublicacion', {
      logGroupName: '/ecs/fbook-publicacion',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ECS Cluster
    this.cluster = new ecs.Cluster(this, 'FbookCluster', {
      clusterName: 'fbook-cluster',
      vpc: props.network.vpc,
    });

    // Cloud Map — namespace privado fbook.local
    this.namespace = new servicediscovery.PrivateDnsNamespace(this, 'FbookNamespace', {
      name: 'fbook.local',
      vpc: props.network.vpc,
      description: 'Service discovery for inter-service communication',
    });

    // Task Execution Role (compartido por los 3 servicios)
    // Permite a ECS hacer pull de ECR y escribir logs en CloudWatch
    this.executionRole = new iam.Role(this, 'FbookTaskExecutionRole', {
      roleName: 'fbook-task-execution-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS Cluster - used by CI/CD for aws ecs update-service',
      exportName: 'FbookClusterName',
    });

    new cdk.CfnOutput(this, 'RepoUsuarioUri', {
      value: this.repoUsuario.repositoryUri,
      exportName: 'FbookRepoUsuarioUri',
    });

    new cdk.CfnOutput(this, 'RepoAmistadUri', {
      value: this.repoAmistad.repositoryUri,
      exportName: 'FbookRepoAmistadUri',
    });

    new cdk.CfnOutput(this, 'RepoPublicacionUri', {
      value: this.repoPublicacion.repositoryUri,
      exportName: 'FbookRepoPublicacionUri',
    });
  }
}
