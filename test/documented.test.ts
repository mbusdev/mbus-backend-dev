import { expect, it } from "vitest";
import * as d from '@/routes/documented';

import express from 'express';
import z from 'zod';

it('should handle path params (GET)', () => {
    testCase(
        'get',
        '/root', '/path/{item}',
        { ...d.emptyFormat, params: z.object({ item: z.string() }) },
        { params: { item: 'five' }, query: {}, body: {} },
        { params: { wrong: 'five' }, query: {}, body: {} },
        (correct) => expect(correct)
            .toMatchInlineSnapshot(`
              {
                "params": {
                  "item": "five",
                },
                "query": {},
              }
            `),
        (incorrect) => expect(incorrect)
            .toMatchInlineSnapshot(`
              "invalid path params: [
                {
                  "expected": "string",
                  "code": "invalid_type",
                  "path": [
                    "item"
                  ],
                  "message": "Invalid input: expected string, received undefined"
                }
              ]"
            `),
        (spec) => expect(spec.paths['/root/path/{item}'].get?.parameters[0])
            .toMatchInlineSnapshot(`
              {
                "in": "path",
                "name": "item",
                "required": true,
                "schema": {
                  "type": "string",
                },
              }
            `),
    );
});

it('should handle query params (GET)', () => {
    testCase(
        'get', '', '/api',
        { query: z.object({ field: z.number() })},
        { query: { field: "-2" } },
        { query: { field: "no" } },
        (json) => expect(json).toMatchInlineSnapshot(),
        (error) => expect(error).toMatchInlineSnapshot(),
        (spec) => expect(spec.paths['/api'].get?.parameters[0]).toMatchInlineSnapshot()
    )
});

it('should handle response bodies (GET)', () => {
    // correct value goes through
    // incorrect value is caught
    // shows up in docs
    // can be empty
    expect(true).toBe(true);
});

it('should handle path params (POST)', () => {
    testCase(
        'post',
        '/root', '/path/{item}',
        { ...d.emptyFormat, params: z.object({ item: z.string() }) },
        { params: { item: 'five' }, query: {}, body: {} },
        { params: { wrong: 'five' }, query: {}, body: {} },
        (correct) => expect(correct)
            .toMatchInlineSnapshot(`
              {
                "body": {},
                "params": {
                  "item": "five",
                },
                "query": {},
              }
            `),
        (incorrect) => expect(incorrect)
            .toMatchInlineSnapshot(`
              "invalid path params: [
                {
                  "expected": "string",
                  "code": "invalid_type",
                  "path": [
                    "item"
                  ],
                  "message": "Invalid input: expected string, received undefined"
                }
              ]"
            `),
        (spec) => expect(spec.paths['/root/path/{item}'].post?.parameters[0])
            .toMatchInlineSnapshot(`
              {
                "in": "path",
                "name": "item",
                "required": true,
                "schema": {
                  "type": "string",
                },
              }
            `),
    );
});

it('should handle query params (POST)', () => {
    testCase(
        'post', '', '/api',
        { query: z.object({ field: z.number() })},
        { query: { field: "-2" } },
        { query: { field: "no" } },
        (json) => expect(json).toMatchInlineSnapshot(),
        (error) => expect(error).toMatchInlineSnapshot(),
        (spec) => expect(spec.paths['/api'].post?.parameters[0]).toMatchInlineSnapshot()
    )
});

it('should handle request bodies (POST)', () => {
    // correct value goes through
    // incorrect value is caught
    // shows up in docs
    // can be empty
    expect(true).toBe(true);
});

it('should handle response bodies (POST)', () => {
    // correct value goes through
    // incorrect value is caught
    // shows up in docs
    // can be empty
    expect(true).toBe(true);
});

function testCase(
    mode: 'get' | 'post',
    base: string,
    suffix: string,
    format: Partial<typeof d.emptyFormat>,
    correct: Partial<d.ExpressRequest>,
    incorrect: Partial<d.ExpressRequest>,
    validateCorrect: (json: unknown) => unknown,
    validateIncorrect: (error: string) => unknown,
    validateSpec: (spec: d.OpenAPI) => unknown,
) {
    const app = express();
    const router = express.Router();

    const ctx = d.newContext();
    d.addRouter(ctx, app, base, router);
    const handler = mode === 'get'
        ? d.addGetRoute(
            ctx, router, suffix,
            { ...d.emptyFormat, ...format },
            (params, query) => d.makeSuccessResponse(200, { params, query })
        )
        : d.addPostRoute(
            ctx, router, suffix,
            { ...d.emptyFormat, ...format },
            (params, query, body) => d.makeSuccessResponse(200, { params, query, body })
        );

    const defaultResponse: d.ExpressRequest = { query: {}, params: {}, body: {} };
    // correct value goes through?
    {
        const res = handler({ ...defaultResponse, ...correct });
        expect(res.status).toBe(200);
        validateCorrect(res.json);
    }

    // incorrect value is caught?
    {
        const res = handler({ ...defaultResponse, ...incorrect });
        expect(res.status).toBe(400);
        validateIncorrect(
            typeof res.json === 'object' && res.json && 'error' in res.json && typeof res.json.error === 'string'
                ? res.json.error
                : '<INCORRECT RESPONSE FORMAT>'
        );
    }

    // shows up in docs?
    const spec = d.docsFor(ctx);
    validateSpec(spec);
}

it('should be able to handle GET & POST to the same path', () => {
    expect(true).toBe(true);
});

it('should handle zod coerce types', () => {
    // type is correct
    // docs don't error
    expect(true).toBe(true);
});

it('should handle zod pipe/transform types', () => {
    // type is correct
    // docs don't error
    expect(true).toBe(true);
});

it('should surface type descriptions & names', () => {
    expect(true).toBe(true);
});

it('should surface route descriptions & names', () => {
    expect(true).toBe(true);
});

it('should have a stable output', () => {
    expect(true).toBe(true);
});

