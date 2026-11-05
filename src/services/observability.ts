import * as HyperDX from '@hyperdx/node-opentelemetry';
import opentelemetry, { Tracer, Meter } from '@opentelemetry/api';
import * as z from 'zod';

// dotenv is NOT used because the otlp endpoint var needs to already be set to work properly
const config = z.object({
    OTEL_KEY: z.string().optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    SERVICE_NAME: z.string().default('local/mbus-backend-dev'),
}).parse(process.env);

export let tracer: Tracer | null = null;
export let meter: Meter | null = null;

if (config.OTEL_KEY && config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // must be before any meters are created
    HyperDX.init({
        apiKey: config.OTEL_KEY,
        service: config.SERVICE_NAME,
    });

    tracer = opentelemetry.trace.getTracer('mbus-backend-dev', '0.1.0');
    meter = opentelemetry.metrics.getMeter('mbus-backend-dev', '0.1.0');

    console.log('otel initialized as ' + config.SERVICE_NAME);
} else {
    console.log('otel is off, make sure key and endpoint are set');
}

