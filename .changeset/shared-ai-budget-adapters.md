---
"@unprice/budgets-ai": minor
"@unprice/pi-budget": minor
"@unprice/ai-sdk-budget": minor
---

Add SDK-independent AI request enforcement, a Pi provider decorator, and native AI SDK middleware. Both adapters share final request validation, cost bounds, reservations, and settlement for OpenAI Responses, Anthropic Messages, and Gemini Developer API text and local tools. OpenAI counts final input; Anthropic and Gemini reserve trusted model input limits because provider counts are estimates.
