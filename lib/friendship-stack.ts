import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { AlbStack } from './alb-stack';

interface FriendshipStackProps extends cdk.StackProps {
  network: NetworkStack;
  alb: AlbStack;
}

export class FriendshipStack extends cdk.Stack {
  readonly table: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props: FriendshipStackProps) {
    super(scope, id, props);

    this.table = new dynamodb.TableV2(this, 'FriendshipsTable', {
      tableName: 'fbook-friendships',
      partitionKey: { name: 'userId',   type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'friendId', type: dynamodb.AttributeType.STRING },
      billing:      dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf update -y',
      "cat > /opt/fbook-svc.py << 'PYEOF'",
      'import http.server, socketserver, json',
      'class H(http.server.BaseHTTPRequestHandler):',
      '    def do_GET(self):',
      '        b = json.dumps({"service": "friendships", "status": "ok"}).encode()',
      '        self.send_response(200)',
      '        self.send_header("Content-Type", "application/json")',
      '        self.end_headers()',
      '        self.wfile.write(b)',
      '    def log_message(self, *a): pass',
      'socketserver.TCPServer(("", 8080), H).serve_forever()',
      'PYEOF',
      "cat > /etc/systemd/system/fbook-svc.service << 'EOF'",
      '[Unit]',
      'Description=Fbook Friendships Service',
      'After=network.target',
      '[Service]',
      'ExecStart=/usr/bin/python3 /opt/fbook-svc.py',
      'Restart=always',
      'User=nobody',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',
      'systemctl daemon-reload',
      'systemctl enable --now fbook-svc',
    );

    const instance = new ec2.Instance(this, 'FriendshipEc2', {
      vpc: props.network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: props.network.sgMicroservice,
      keyPair: props.network.keyPair,
      userData,
    });

    this.table.grantReadWriteData(instance.role);

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'FriendshipTg', {
      vpc: props.network.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new targets.InstanceTarget(instance, 8080)],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    new elbv2.ApplicationListenerRule(this, 'FriendshipRule', {
      listener: props.alb.listener,
      priority: 30,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/friendships', '/api/friendships/*']),
      ],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    new cdk.CfnOutput(this, 'FriendshipInstanceId', {
      value: instance.instanceId,
      description: 'ID de la instancia EC2 (para SSH via Bastion)',
    });

    new cdk.CfnOutput(this, 'FriendshipPrivateIp', {
      value: instance.instancePrivateIp,
      description: 'IP privada del EC2 Friendship',
    });

    new cdk.CfnOutput(this, 'FriendshipsTableName', {
      value: this.table.tableName,
    });
  }
}
