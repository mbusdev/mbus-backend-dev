import * as HyperDX from '@hyperdx/node-opentelemetry';
import { HostMetrics } from '@opentelemetry/host-metrics';
import { metrics } from '@opentelemetry/api'

// dotenv is NOT used because the otlp endpoint var needs to already be set to work properly
const otelKey = process.env.OTEL_KEY;
const otelExporterOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const serviceName = process.env.SERVICE_NAME ?? 'local/mbus-backend-dev';

if (otelKey && otelExporterOtlpEndpoint) {
    // must be before any meters are created
    HyperDX.initSDK({
        apiKey: otelKey,
        service: serviceName,
        experimentalExceptionCapture: true,
    });

    new HostMetrics({
        meterProvider: metrics.getMeterProvider(),
    }).start();

    console.log('otel initialized as ' + serviceName);
} else {
    console.log('otel is off, make sure key and endpoint are set');
}

