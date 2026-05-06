import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { AlbStack } from './alb-stack';
import { UsersStack } from './users-stack';
import { AmistadStack } from './amistad-stack';
import { PublicationStack } from './publication-stack';

interface DashboardStackProps extends cdk.StackProps {
  alb: AlbStack;
  users: UsersStack;
  amistad: AmistadStack;
  publication: PublicationStack;
}

const SERVICES = [
  { name: 'usuario',     logGroup: '/fbook/usuario',     emfNamespace: 'Fbook/Usuario' },
  { name: 'amistad',     logGroup: '/fbook/amistad',     emfNamespace: 'Fbook/Amistad' },
  { name: 'publicacion', logGroup: '/fbook/publicacion', emfNamespace: 'Fbook/Publicacion' },
];

export class DashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    const dashboard = new cloudwatch.Dashboard(this, 'FbookDashboard', {
      dashboardName: 'fbook-overview',
    });

    // ── Row 1: Errores recientes en logs (1 widget por servicio) ─────────────
    dashboard.addWidgets(
      ...SERVICES.map(svc => new cloudwatch.LogQueryWidget({
        title: `Errores recientes — ${svc.name}`,
        logGroupNames: [svc.logGroup],
        queryLines: [
          'fields @timestamp, @message',
          'filter @message like /(?i)(error|exception|fail)/',
          'sort @timestamp desc',
          'limit 50',
        ],
        width: 8,
        height: 6,
      })),
    );

    // ── Row 2: Latencia EMF p50/p99 por servicio ────────────────────────────
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Latencia request (p50 / p99)',
        left: SERVICES.map(svc => new cloudwatch.Metric({
          namespace: svc.emfNamespace,
          metricName: 'RequestLatencyMs',
          dimensionsMap: { Service: svc.name },
          statistic: 'p50',
          label: `${svc.name} p50`,
          period: cdk.Duration.minutes(1),
        })),
        right: SERVICES.map(svc => new cloudwatch.Metric({
          namespace: svc.emfNamespace,
          metricName: 'RequestLatencyMs',
          dimensionsMap: { Service: svc.name },
          statistic: 'p99',
          label: `${svc.name} p99`,
          period: cdk.Duration.minutes(1),
        })),
        leftYAxis: { label: 'p50 (ms)', showUnits: false },
        rightYAxis: { label: 'p99 (ms)', showUnits: false },
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Throughput y errores (EMF)',
        left: SERVICES.map(svc => new cloudwatch.Metric({
          namespace: svc.emfNamespace,
          metricName: 'RequestCount',
          dimensionsMap: { Service: svc.name },
          statistic: 'Sum',
          label: `${svc.name} requests`,
          period: cdk.Duration.minutes(1),
        })),
        right: SERVICES.map(svc => new cloudwatch.Metric({
          namespace: svc.emfNamespace,
          metricName: 'ErrorCount',
          dimensionsMap: { Service: svc.name },
          statistic: 'Sum',
          label: `${svc.name} errors`,
          period: cdk.Duration.minutes(1),
        })),
        width: 12,
        height: 6,
      }),
    );

    // ── Row 3: EC2 health (CPU + Status check) ──────────────────────────────
    const instances = [
      { name: 'usuario',     instance: props.users.instance },
      { name: 'amistad',     instance: props.amistad.instance },
      { name: 'publicacion', instance: props.publication.instance },
    ];

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'EC2 — CPU Utilization (%)',
        left: instances.map(i => new cloudwatch.Metric({
          namespace: 'AWS/EC2',
          metricName: 'CPUUtilization',
          dimensionsMap: { InstanceId: i.instance.instanceId },
          statistic: 'Average',
          label: i.name,
          period: cdk.Duration.minutes(5),
        })),
        leftYAxis: { min: 0, max: 100, showUnits: false },
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'EC2 — Status Check Failed',
        left: instances.map(i => new cloudwatch.Metric({
          namespace: 'AWS/EC2',
          metricName: 'StatusCheckFailed',
          dimensionsMap: { InstanceId: i.instance.instanceId },
          statistic: 'Maximum',
          label: i.name,
          period: cdk.Duration.minutes(1),
        })),
        width: 12,
        height: 6,
      }),
    );

    // ── Row 4: ALB target group health ──────────────────────────────────────
    const targetGroups = [
      { name: 'usuario',     tg: props.users.targetGroup },
      { name: 'amistad',     tg: props.amistad.targetGroup },
      { name: 'publicacion', tg: props.publication.targetGroup },
    ];

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ALB — Healthy hosts por target group',
        left: targetGroups.map(t => t.tg.metrics.healthyHostCount({
          label: t.name,
          period: cdk.Duration.minutes(1),
        })),
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB — HTTP 5XX por target group',
        left: targetGroups.map(t => t.tg.metrics.httpCodeTarget(
          cdk.aws_elasticloadbalancingv2.HttpCodeTarget.TARGET_5XX_COUNT,
          { label: t.name, period: cdk.Duration.minutes(1), statistic: 'Sum' },
        )),
        width: 12,
        height: 6,
      }),
    );

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
      description: 'CloudWatch Dashboard URL',
    });
  }
}
