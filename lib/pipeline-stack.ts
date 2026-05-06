import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as cpactions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

interface PipelineStackProps extends cdk.StackProps {
  codestarConnectionArn: string;
  githubOwner: string; // ej. "Sergiovil64"
  githubRepo: string;  // ej. "fbook-api"
  githubBranch: string; // rama por default; el filtro real es por tag via EventBridge
}

const SERVICES = ['usuario', 'amistad', 'publicacion'] as const;

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    SERVICES.forEach(svc => {
      // ── ECR repo (importado, ya existe) ────────────────────────────────────
      const repo = ecr.Repository.fromRepositoryName(
        this, `${svc}EcrRepo`, `fbook-service-${svc}`,
      );

      // ── Artifacts ───────────────────────────────────────────────────────────
      const sourceArtifact = new codepipeline.Artifact(`${svc}Source`);
      const buildArtifact  = new codepipeline.Artifact(`${svc}Build`);

      // ── Build project ──────────────────────────────────────────────────────
      const buildProject = new codebuild.PipelineProject(this, `${svc}BuildProject`, {
        projectName: `fbook-build-${svc}`,
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          privileged: true, // necesario para docker build
          computeType: codebuild.ComputeType.SMALL,
        },
        buildSpec: codebuild.BuildSpec.fromSourceFilename(`buildspec-${svc}.yml`),
        environmentVariables: {
          AWS_REGION: { value: this.region },
          AWS_ACCOUNT_ID: { value: this.account },
          SERVICE: { value: svc },
          REPO_URI: { value: repo.repositoryUri },
        },
      });
      // Permisos para login y push a ECR
      repo.grantPullPush(buildProject);
      buildProject.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }));

      // ── Deploy project (aws ecs update-service --force-new-deployment) ─────
      const deployProject = new codebuild.PipelineProject(this, `${svc}DeployProject`, {
        projectName: `fbook-deploy-${svc}`,
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          computeType: codebuild.ComputeType.SMALL,
        },
        environmentVariables: {
          AWS_REGION:   { value: this.region },
          CLUSTER_NAME: { value: 'fbook-cluster' },
          SERVICE_NAME: { value: `fbook-service-${svc}` },
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: {
            build: {
              commands: [
                'VERSION=$(jq -r .version image-info.json)',
                'echo "Forcing new deployment of $SERVICE_NAME on $CLUSTER_NAME (image version $VERSION)"',
                // El service apunta a ":latest". Build ya pusheó :latest al digest nuevo;
                // --force-new-deployment hace que ECS pull el digest actual y haga rollout blue-green natural.
                'aws ecs update-service --cluster $CLUSTER_NAME --service $SERVICE_NAME --force-new-deployment --region $AWS_REGION',
                'aws ecs wait services-stable --cluster $CLUSTER_NAME --services $SERVICE_NAME --region $AWS_REGION',
                'echo "Deploy completed."',
              ],
            },
          },
        }),
      });
      deployProject.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'ecs:UpdateService',
          'ecs:DescribeServices',
          'ecs:DescribeTasks',
          'ecs:ListTasks',
        ],
        resources: ['*'],
      }));
      // PassRole para que update-service pueda re-asociar TaskRole/ExecutionRole de la TaskDef
      deployProject.addToRolePolicy(new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: ['*'],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }));

      // ── Pipeline ───────────────────────────────────────────────────────────
      const pipeline = new codepipeline.Pipeline(this, `${svc}Pipeline`, {
        pipelineName: `fbook-pipeline-${svc}`,
        restartExecutionOnUpdate: false,
      });

      pipeline.addStage({
        stageName: 'Source',
        actions: [
          new cpactions.CodeStarConnectionsSourceAction({
            actionName: 'GitHub_Source',
            owner: props.githubOwner,
            repo: props.githubRepo,
            branch: props.githubBranch,
            connectionArn: props.codestarConnectionArn,
            output: sourceArtifact,
            // No queremos disparar en cada push; el trigger real es por tag (EventBridge rule abajo)
            triggerOnPush: false,
            // Full git clone en CodeBuild para que `git describe --exact-match --tags HEAD`
            // pueda derivar la versión del tag dentro del buildspec.
            codeBuildCloneOutput: true,
          }),
        ],
      });

      pipeline.addStage({
        stageName: 'Build',
        actions: [
          new cpactions.CodeBuildAction({
            actionName: 'Docker_Build_Push',
            project: buildProject,
            input: sourceArtifact,
            outputs: [buildArtifact],
          }),
        ],
      });

      pipeline.addStage({
        stageName: 'Deploy',
        actions: [
          new cpactions.CodeBuildAction({
            actionName: 'Ecs_Update_Service',
            project: deployProject,
            input: buildArtifact,
          }),
        ],
      });

      // ── EventBridge rule: dispara el pipeline solo cuando llega un tag con prefijo del servicio ──
      new events.Rule(this, `${svc}TagRule`, {
        ruleName: `fbook-${svc}-tag-trigger`,
        description: `Triggers ${svc} pipeline when a tag like ${svc}-v* is pushed to GitHub`,
        eventPattern: {
          source: ['aws.codeconnections'],
          detailType: ['CodeStarSourceConnection Repository State Change'],
          detail: {
            event: ['referenceCreated', 'referenceUpdated'],
            referenceType: ['tag'],
            referenceName: [{ prefix: `${svc}-v` }],
          },
        },
        targets: [new targets.CodePipeline(pipeline)],
      });

      new cdk.CfnOutput(this, `${svc}PipelineName`, { value: pipeline.pipelineName });
    });

    new cdk.CfnOutput(this, 'TagFormatHint', {
      value: 'Tag git con formato <servicio>-vX.Y.Z (ej. usuario-v1.0.0) para disparar el pipeline correspondiente',
    });
  }
}