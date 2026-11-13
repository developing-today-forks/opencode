import { createLead, type SalesforceLeadInput } from "./salesforce"

// Test-only entrypoint spawned by salesforce.test.ts (see runLeadAttempt).
// SST's Resource snapshots process env process-wide at first access, so each
// fake-instance scenario runs here in a fresh process with
// SST_RESOURCE_SALESFORCE_INSTANCE_URL preset to its scenario server.
// Stdout carries exactly one JSON line; createLead's own error logs go to stderr.
const input = JSON.parse(process.argv[2] ?? "{}") as SalesforceLeadInput
const accepted = await createLead(input)
console.log(JSON.stringify({ accepted }))
