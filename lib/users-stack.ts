import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { AlbStack } from './alb-stack';

interface UsersStackProps extends cdk.StackProps {
  network: NetworkStack;
  alb: AlbStack;
}

export class UsersStack extends cdk.Stack {
  readonly table: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props: UsersStackProps) {
    super(scope, id, props);

    // ── Tabla DynamoDB ────────────────────────────────────────────────────────
    this.table = new dynamodb.TableV2(this, 'UsuariosTable', {
      tableName: 'Usuarios',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.NUMBER },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── User Data ─────────────────────────────────────────────────────────────
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf update -y',
      // Env file que usará el contenedor Docker cuando se integre ECR
      "cat > /opt/fbook.env << 'EOF'",
      'TABLE_NAME=Usuarios',
      'AWS_REGION=us-east-1',
      'PORT=3000',
      'EOF',
      // Servidor placeholder en Python — reemplazar con Docker en el paso ECR
      "cat > /opt/fbook-svc.py << 'PYEOF'",
      'import http.server, socketserver, json',
      'class H(http.server.BaseHTTPRequestHandler):',
      '    def do_GET(self):',
      '        b = json.dumps({"service": "usuarios", "status": "ok"}).encode()',
      '        self.send_response(200)',
      '        self.send_header("Content-Type", "application/json")',
      '        self.end_headers()',
      '        self.wfile.write(b)',
      '    def log_message(self, *a): pass',
      'socketserver.TCPServer(("", 3000), H).serve_forever()',
      'PYEOF',
      "cat > /etc/systemd/system/fbook-svc.service << 'EOF'",
      '[Unit]',
      'Description=Fbook Usuarios Service',
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

    // ── EC2 con IP privada estática ───────────────────────────────────────────
    const privateSubnet = props.network.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets[0];

    const instance = new ec2.Instance(this, 'UsuarioEc2', {
      vpc: props.network.vpc,
      vpcSubnets: { subnets: [privateSubnet] },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: props.network.sgMicroservice,
      keyPair: props.network.keyPair,
      privateIpAddress: '10.0.2.10',
      userData,
    });

    this.table.grantReadWriteData(instance.role);

    // ── ALB Target Group + Listener Rule ──────────────────────────────────────
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'UsuarioTg', {
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

    new elbv2.ApplicationListenerRule(this, 'UsuarioRule', {
      listener: props.alb.listener,
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/v1/usuarios', '/v1/usuarios/*']),
      ],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'UsuarioInstanceId', {
      value: instance.instanceId,
      description: 'ID de la instancia EC2 (para SSH via Bastion)',
    });

    new cdk.CfnOutput(this, 'UsuarioPrivateIp', {
      value: instance.instancePrivateIp,
    });

    new cdk.CfnOutput(this, 'UsuariosTableName', {
      value: this.table.tableName,
    });
  }
}
