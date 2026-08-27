import { NodeSDK } from "@opentelemetry/sdk-node";

/** Starts OpenTelemetry export to the OTEL_EXPORTER_OTLP_ENDPOINT collector. */
export function startTelemetry(): NodeSDK {
    const sdk = new NodeSDK();
    sdk.start();
    return sdk;
}
