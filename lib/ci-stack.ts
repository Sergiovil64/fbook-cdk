import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as cpactions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { Construct } from 'constructs';

interface CiStackProps extends cdk.StackProps {
  codestarConnectionArn: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
}

const SERVICES = ['usuario', 'amistad', 'publicacion'] as const;

export class CiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);

    const sourceArtifact = new codepipeline.Artifact('CiSource');

    const ciProject = new codebuild.PipelineProject(this, 'CiBuildProject', {
      projectName: 'fbook-ci-build',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        env: { shell: 'bash' },
        phases: {
          build: {
            commands: [
              'echo "=== CI: type-check + build de los 3 microservicios ==="',
              ...SERVICES.flatMap(svc => [
                `echo "--- ${svc} ---"`,
                `(cd services/${svc} && npm ci && npm run build)`,
              ]),
              'echo "All services built successfully."',
            ],
          },
        },
      }),
    });

    const sourceAction = new cpactions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub_Source',
      owner: props.githubOwner,
      repo: props.githubRepo,
      branch: props.githubBranch,
      connectionArn: props.codestarConnectionArn,
      output: sourceArtifact,
      // Los triggers V2 controlan el flujo (push a main + PRs).
      triggerOnPush: false,
    });

    const buildAction = new cpactions.CodeBuildAction({
      actionName: 'Lint_TypeCheck_Build',
      project: ciProject,
      input: sourceArtifact,
    });

    const pipeline = new codepipeline.Pipeline(this, 'CiPipeline', {
      pipelineName: 'fbook-pipeline-ci',
      pipelineType: codepipeline.PipelineType.V2,
      restartExecutionOnUpdate: false,
      stages: [
        { stageName: 'Source', actions: [sourceAction] },
        { stageName: 'Build',  actions: [buildAction]  },
      ],
      triggers: [{
        providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
        gitConfiguration: {
          sourceAction,
          pushFilter: [{
            branchesIncludes: [props.githubBranch],
          }],
          pullRequestFilter: [{
            branchesIncludes: [props.githubBranch],
            events: [
              codepipeline.GitPullRequestEvent.OPEN,
              codepipeline.GitPullRequestEvent.UPDATED,
            ],
          }],
        },
      }],
    });

    new cdk.CfnOutput(this, 'CiPipelineName', { value: pipeline.pipelineName });
  }
}
