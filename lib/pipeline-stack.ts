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

      // ── Deploy project (SSM Run Command al EC2 target) ─────────────────────
      const deployProject = new codebuild.PipelineProject(this, `${svc}DeployProject`, {
        projectName: `fbook-deploy-${svc}`,
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          computeType: codebuild.ComputeType.SMALL,
        },
        environmentVariables: {
          AWS_REGION: { value: this.region },
          AWS_ACCOUNT_ID: { value: this.account },
          SERVICE: { value: svc },
          REPO_URI: { value: repo.repositoryUri },
          LOG_GROUP: { value: `/fbook/${svc}` },
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: {
            build: {
              commands: [
                'echo "Deploying $SERVICE version $(cat image-info.json | jq -r .version)"',
                'VERSION=$(cat image-info.json | jq -r .version)',
                // El comando que SSM ejecuta dentro del EC2:
                'cat > /tmp/deploy.sh <<EOF',
                '#!/bin/bash',
                'set -e',
                'aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com',
                'docker pull ${REPO_URI}:${VERSION}',
                'docker rm -f fbook-svc || true',
                'docker run -d --name fbook-svc --restart always \\',
                '  --log-driver=awslogs \\',
                '  --log-opt awslogs-region=${AWS_REGION} \\',
                '  --log-opt awslogs-group=${LOG_GROUP} \\',
                '  --log-opt awslogs-stream-prefix=ec2 \\',
                '  -p 3000:3000 --env-file /opt/fbook.env \\',
                '  ${REPO_URI}:${VERSION}',
                'EOF',
                // Sustituir variables locales del CodeBuild en el script
                'envsubst < /tmp/deploy.sh > /tmp/deploy.final.sh',
                'CMDS=$(jq -Rs . /tmp/deploy.final.sh)',
                // Mandar el script al EC2 con el tag Service=<svc>
                'CMD_ID=$(aws ssm send-command \\',
                '  --document-name "AWS-RunShellScript" \\',
                '  --targets "Key=tag:Service,Values=${SERVICE}" \\',
                '  --parameters commands="[${CMDS}]" \\',
                '  --comment "Deploy ${SERVICE}:${VERSION}" \\',
                '  --query "Command.CommandId" --output text)',
                'echo "Sent SSM command: $CMD_ID"',
                // Esperar que termine
                'INSTANCE_ID=$(aws ec2 describe-instances --filters "Name=tag:Service,Values=${SERVICE}" "Name=instance-state-name,Values=running" --query "Reservations[0].Instances[0].InstanceId" --output text)',
                'echo "Waiting for SSM command on $INSTANCE_ID..."',
                'aws ssm wait command-executed --command-id $CMD_ID --instance-id $INSTANCE_ID',
                'aws ssm get-command-invocation --command-id $CMD_ID --instance-id $INSTANCE_ID --query "Status" --output text',
              ],
            },
          },
        }),
      });
      deployProject.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'ssm:SendCommand',
          'ssm:GetCommandInvocation',
          'ssm:DescribeInstanceInformation',
          'ec2:DescribeInstances',
        ],
        resources: ['*'],
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
            actionName: 'SSM_Deploy_To_EC2',
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