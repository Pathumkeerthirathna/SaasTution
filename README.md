# SaasTution

Next.js 14 starter project with:

- App Router + TypeScript
- Tailwind CSS (mobile-first responsive setup)
- Prisma + PostgreSQL integration
- Async service/API utilities using async/await
- Standardized API success/error response envelopes
- Shared pagination helpers for future query endpoints

## Folder Structure

```
app/
components/
lib/
prisma/
services/
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy environment variables and configure PostgreSQL:

```bash
cp .env.example .env
```

3. Generate Prisma client:

```bash
npm run prisma:generate
```

4. Run migrations:

```bash
npm run prisma:migrate -- --name init
```

5. Start development server:

```bash
npm run dev
```

## API Response Format

Success:

```json
{
	"success": true,
	"data": {},
	"message": "Optional message",
	"pagination": {
		"page": 1,
		"pageSize": 10,
		"totalItems": 100,
		"totalPages": 10,
		"hasNextPage": true,
		"hasPreviousPage": false
	}
}
```

Error:

```json
{
	"success": false,
	"error": {
		"message": "Something went wrong",
		"code": "ERROR_CODE",
		"details": {}
	}
}
```
