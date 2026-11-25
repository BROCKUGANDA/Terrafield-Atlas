import { NextResponse } from 'next/server';
import { openApiDocument } from '@/lib/openapi';

export function GET() {
  return NextResponse.json(openApiDocument, {
    headers: { 'Cache-Control': 'public, max-age=300', 'X-Correlation-Id': crypto.randomUUID() },
  });
}
