import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as cpactions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface PipelineStackProps extends cdk.StackProps {
  codestarConnectionArn: string;
  githubOwner: string; // ej. "Sergiovil64"
  githubRepo: string;  // ej. "fbook-api"
  githubBranch: string; // rama por default; el filtro real es por tag via Pipeline V2 trigger
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
                // Polling del rolloutState del PRIMARY deployment.
                // Reemplaza `aws ecs wait services-stable` (timeout fijo 10 min, falla si hay deployments stale en flight).
                // 60 intentos × 30s = 30 min de techo.
                'for i in $(seq 1 60); do STATE=$(aws ecs describe-services --cluster $CLUSTER_NAME --services $SERVICE_NAME --region $AWS_REGION --query \'services[0].deployments[?status==`PRIMARY`].rolloutState\' --output text); echo "Attempt $i/60: PRIMARY rolloutState = $STATE"; if [ "$STATE" = "COMPLETED" ]; then echo "Deploy completed."; exit 0; fi; if [ "$STATE" = "FAILED" ]; then echo "Deploy FAILED (rollout state)."; exit 1; fi; sleep 30; done; echo "ERROR: Deploy did not converge within 30 minutes."; exit 1',
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

      // ── Source/Build/Deploy actions (declaradas afuera para referenciarlas en triggers) ──
      const sourceAction = new cpactions.CodeStarConnectionsSourceAction({
        actionName: 'GitHub_Source',
        owner: props.githubOwner,
        repo: props.githubRepo,
        branch: props.githubBranch,
        connectionArn: props.codestarConnectionArn,
        output: sourceArtifact,
        // El trigger real lo define el `triggers` del pipeline (V2) — filtra por tag.
        // Apagamos el auto-trigger del action para que no dispare en cada push a `main`.
        triggerOnPush: false,
        // Full git clone para que `git describe --exact-match --tags HEAD` funcione en el buildspec.
        codeBuildCloneOutput: true,
      });

      const buildAction = new cpactions.CodeBuildAction({
        actionName: 'Docker_Build_Push',
        project: buildProject,
        input: sourceArtifact,
        outputs: [buildArtifact],
      });

      const deployAction = new cpactions.CodeBuildAction({
        actionName: 'Ecs_Update_Service',
        project: deployProject,
        input: buildArtifact,
      });

      // ── Pipeline V2 con trigger nativo por tag git ─────────────────────────
      const pipeline = new codepipeline.Pipeline(this, `${svc}Pipeline`, {
        pipelineName: `fbook-pipeline-${svc}`,
        pipelineType: codepipeline.PipelineType.V2,
        restartExecutionOnUpdate: false,
        stages: [
          { stageName: 'Source', actions: [sourceAction] },
          { stageName: 'Build',  actions: [buildAction]  },
          { stageName: 'Deploy', actions: [deployAction] },
        ],
        triggers: [{
          providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
          gitConfiguration: {
            sourceAction: sourceAction,
            pushFilter: [{
              tagsIncludes: [`${svc}-v*`],
            }],
          },
        }],
      });

      new cdk.CfnOutput(this, `${svc}PipelineName`, { value: pipeline.pipelineName });
    });

    new cdk.CfnOutput(this, 'TagFormatHint', {
      value: 'Tag git con formato <servicio>-vX.Y.Z (ej. usuario-v1.0.0) para disparar el pipeline correspondiente',
    });
  }
}