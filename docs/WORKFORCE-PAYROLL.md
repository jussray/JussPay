# Workforce and Payroll — preview foundation

This branch adds a disabled-by-default, authenticated, stateless synthetic preview to the existing Worker. It does not collect employee identities, SSNs, bank details, real timesheets, tax forms or payroll data. It cannot submit payroll, transfer funds or change Stripe or JBH configuration.

## Routes (private app-server access)
Use the existing verified visitor-scoped JussPay bearer identity. Set WORKFORCE_PREVIEW_ENABLED=true only in an authorized test environment. No public browser CORS or payment activation is added.
- GET /workforce/overview: exact module readiness, no invented employee or provider records.
- POST /workforce/preview: fictional regularMinutes, overtimeMinutes, hourlyCents only; integer cents; illustrative US-style 1.5x overtime, not jurisdiction-specific payroll or net pay.
- GET /workforce/tools: read-only agent tool definitions.
- POST /workforce/tools/call: name and arguments, restricted to workforce_overview and preview_payroll. This is an internal API contract, not an MCP transport or registered ChatGPT app.

## Remaining end-to-end gates
1. Existing branded frontend: add protected Workforce navigation, People, onboarding, time approvals and payroll views. Do not replace the existing visual canon. Frontend repository is not identified by this change.
2. Establish server-side company memberships and scoped owner/payroll admin/employee roles. Verify role revocation, company isolation, minimum data collection, retention and provider-hosted sensitive onboarding. Never trust a client-supplied tenant or role.
3. Use an approved payroll provider's demo environment first. Gusto Embedded offers company/employee onboarding, payroll and filings; commercial and security approval precede production. Keep provider credentials in private secret storage and bind company IDs to authenticated company membership server-side. Do not use an account-wide token for unrestricted tenant access.
4. Implement provider-calculated preview, immutable approval tied to exact company/payroll/version and digest, expiry, idempotency, distinct approver policy, provider-side submission and verified reconciliation. Never treat a network timeout as proof of failure or repeat unknown financial side effects. Verify webhook signatures and re-read authoritative provider records.
5. Create an authenticated MCP server for read-only summaries and draft previews with user consent and scoped OAuth. Never return tax IDs, bank data or raw employee details to agent tools. ChatGPT listing and provider approval are separate gates.
6. Run focused and full repository tests, staging browser checks, provider demo reconciliation and tenant-isolation tests before any production review. This branch alone is not proof of production readiness.

References: https://docs.gusto.com/embedded-payroll/docs/getting-started and https://embedded.gusto.com/product/payroll-api.
