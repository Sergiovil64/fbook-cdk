import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';

interface BastionStackProps extends cdk.StackProps {
  network: NetworkStack;
}

export class BastionStack extends cdk.Stack {
  readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: BastionStackProps) {
    super(scope, id, props);

    const userData = ec2.UserData.forLinux();
    userData.addCommands('echo "keypair=fbook-key-manual" > /opt/fbook-version');

    this.instance = new ec2.Instance(this, 'Bastion', {
      vpc: props.network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: props.network.sgBastion,
      keyPair: props.network.keyPair,
      associatePublicIpAddress: true,
      userData,
      userDataCausesReplacement: true,
    });

    // Outputs
    new cdk.CfnOutput(this, 'BastionPublicIp', {
      value: this.instance.instancePublicIp,
      description: 'Public IP of the Bastion',
    });

    new cdk.CfnOutput(this, 'SshCommand', {
      value: `ssh -i fbook-key.pem ec2-user@${this.instance.instancePublicIp}`,
      description: 'SSH command to the Bastion',
    });

    new cdk.CfnOutput(this, 'SshTunnelExample', {
      value: `ssh -i fbook-key.pem -J ec2-user@${this.instance.instancePublicIp} ec2-user@<private-ec2-ip>`,
      description: 'SSH to a private EC2 using the Bastion as a jump host',
    });
  }
}
