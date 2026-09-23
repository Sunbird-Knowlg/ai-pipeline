import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

let sdk: NodeSDK | undefined;

/**
 * Starts tracing only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so local runs and tests stay
 * quiet. Spans come from the Restate SDK hook and our own `trace.getTracer()` calls; no
 * auto-instrumentation is installed.
 */
export function startTelemetry(serviceName: string): { shutdown(): Promise<void> } {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || sdk) return { shutdown: async () => sdk?.shutdown() };
  sdk = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME ?? serviceName }),
    ),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
      ),
    ],
  });
  sdk.start();
  const started = sdk;
  return { shutdown: () => started.shutdown() };
}
