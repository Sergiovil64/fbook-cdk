import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';

interface AlbStackProps extends cdk.StackProps {
  network: NetworkStack;
}

export class AlbStack extends cdk.Stack {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly listener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props: AlbStackProps) {
    super(scope, id, props);

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'FbookAlb', {
      vpc: props.network.vpc,
      internetFacing: true,
      securityGroup: props.network.sgAlb,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    this.listener = this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'application/json',
        messageBody: JSON.stringify({ error: 'Page Not found.' }),
      }),
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'Base URL of the API: http://<dns>/api/...',
    });

    new cdk.CfnOutput(this, 'PublicationsEndpoint', {
      value: `http://${this.alb.loadBalancerDnsName}/api/publications`,
    });

    new cdk.CfnOutput(this, 'CommentsEndpoint', {
      value: `http://${this.alb.loadBalancerDnsName}/api/comments`,
    });

    new cdk.CfnOutput(this, 'FriendshipsEndpoint', {
      value: `http://${this.alb.loadBalancerDnsName}/api/friendships`,
    });
  }
}
