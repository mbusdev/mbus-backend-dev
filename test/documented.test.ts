import { beforeAll, expect, it } from "vitest";
import * as d from '@/routes/documented';

import express from 'express';
import z from 'zod';

beforeAll(() => {
    if (!d.ENABLED) {
        throw new Error('documented must be enabled');
    }
});

it('should handle path params (GET)', async () => {
    await testCase(
        'get',
        '/root', '/path/{item}',
        { params: z.strictObject({ item: z.string() }) },
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
              "invalid path params:
              - item: Invalid input: expected string, received undefined
              - Unrecognized key: "wrong""
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

it('should accept params named id', async () => {
    await testCase(
        'get',
        '', '/test',
        { params: z.object({ id: z.string() }) },
        {}, {}, null, null,
        (spec) => expect(spec.paths['/test'].get?.parameters[0].name).toEqual("id")
    );
});

it('should work with schemas containing id', async () => {
    const B = z.object({ id: z.number() }).meta({ id: 'B'});
    await testCase(
        'post',
        '', '/test',
        { reqBody: B, resBody: B },
        {}, {}, null, null,
        (spec) => expect(spec.components.schemas.B.properties).toHaveProperty('id'),
    );
});

it('should handle query params (GET)', async () => {
    await testCase(
        'get', '', '/api',
        { query: z.object({ field: z.coerce.number() })},
        { query: { field: "-2" } },
        { query: { field: "no" } },
        (json) => expect(json).toMatchInlineSnapshot(`
          {
            "params": {},
            "query": {
              "field": -2,
            },
          }
        `),
        (error) => expect(error).toMatchInlineSnapshot(`
          "invalid query params:
          - field: Invalid input: expected number, received NaN"
        `),
        (spec) => expect(spec.paths['/api'].get?.parameters[0]).toMatchInlineSnapshot(`
          {
            "in": "query",
            "name": "field",
            "required": true,
            "schema": {
              "type": "number",
            },
          }
        `)
    )
});

it('should handle response bodies (GET)', async () => {
    // shows up in docs
    await testCase(
        'get', '/4', '/34',
        { resBody: z.number() },
        {}, {},
        (json) => expect(json).toMatchInlineSnapshot(`
          {
            "params": {},
            "query": {},
          }
        `),
        null,
        (spec) => expect(spec.paths['/4/34'].get?.responses["200"].content?.["application/json"].schema)
            .toMatchInlineSnapshot(`
              {
                "type": "number",
              }
            `)
    );
    // can be empty
    await testCase(
        'get', '', '/h', {}, {}, {}, null, null,
        (spec) => expect(spec.paths['/h'].get!.responses["200"].content)
            .toMatchInlineSnapshot(`undefined`)
    );
});

it('should handle path params (POST)', async () => {
    await testCase(
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
              "invalid path params:
              - item: Invalid input: expected string, received undefined"
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

it('should handle query params (POST)', async () => {
    await testCase(
        'post', '', '/api',
        { query: z.object({ field: z.coerce.number() })},
        { query: { field: "-2" } },
        { query: { field: "no" } },
        (json) => expect(json).toMatchInlineSnapshot(`
          {
            "body": {},
            "params": {},
            "query": {
              "field": -2,
            },
          }
        `),
        (error) => expect(error).toMatchInlineSnapshot(`
          "invalid query params:
          - field: Invalid input: expected number, received NaN"
        `),
        (spec) => expect(spec.paths['/api'].post?.parameters[0]).toMatchInlineSnapshot(`
          {
            "in": "query",
            "name": "field",
            "required": true,
            "schema": {
              "type": "number",
            },
          }
        `)
    )
});

it('should handle request bodies (POST)', async () => {
    await testCase(
        'post', '/a/b', '/c',
        { reqBody: z.object({ field: z.boolean() })},
        { body: { field: true } },
        { body: { field: [] } },
        (json) => expect(json).toMatchInlineSnapshot(`
          {
            "body": {
              "field": true,
            },
            "params": {},
            "query": {},
          }
        `),
        (error) => expect(error).toMatchInlineSnapshot(`
          "invalid body:
          - field: Invalid input: expected boolean, received array"
        `),
        (spec) => expect(spec.paths['/a/b/c'].post?.parameters[0]).toMatchInlineSnapshot(`undefined`)
    )
});

it('should handle response bodies (POST)', async () => {
    // shows up in docs
    await testCase(
        'post', '/4', '/34',
        { resBody: z.number() },
        {}, {},
        (json) => expect(json).toMatchInlineSnapshot(`
          {
            "body": {},
            "params": {},
            "query": {},
          }
        `),
        null,
        (spec) => expect(spec.paths['/4/34'].post?.responses["200"].content?.["application/json"].schema)
            .toMatchInlineSnapshot(`
              {
                "type": "number",
              }
            `)
    );
    // can be empty
    await testCase(
        'post', '', '/h', {}, {}, {}, null, null,
        (spec) => expect(spec.paths['/h'].post!.responses["200"].content)
            .toMatchInlineSnapshot(`undefined`)
    );
});


it('should be able to handle GET & POST to the same path', () => {
    const app = express();
    const router = express.Router();

    const ctx = d.newContext();
    d.addRouter(ctx, app, '', router);

    d.addGetRoute(ctx, router, '/rt', d.emptyFormat, async () => d.makeSuccessResponse({}), {});
    d.addPostRoute(ctx, router, '/rt', d.emptyFormat, async () => d.makeSuccessResponse({}), {});

    const path = d.docsFor(ctx).paths['/rt'];
    expect(path.get).toBeDefined();
    expect(path.post).toBeDefined();
    expect(path.get).toEqual(path.post);
});

it('should handle zod transform types in the request', async () => {
    const app = express();
    const router = express.Router();

    const ctx = d.newContext();
    d.addRouter(ctx, app, '', router);

    const handler = d.addPostRoute(
        ctx, router, '/rt',
        { ...d.emptyFormat, reqBody: z.string().transform((s) => s.toLowerCase()) },
        async (_, __, body) => d.makeSuccessResponse(body)
    );
    const res = await handler({ params: {}, query: {}, body: 'HI' });
    expect(res.json).toMatchInlineSnapshot(`"hi"`);
});

it('should surface type descriptions & names', () => {
    const app = express();
    const router = express.Router();

    const ctx = d.newContext();
    d.addRouter(ctx, app, '', router);
    d.addGetRoute(
        ctx, router, '/pan',
        { ...d.emptyFormat, resBody: z.object().meta({ id: 'Obj', description: 'obj' }) },
        async () => d.makeSuccessResponse({})
    );
    const spec = d.docsFor(ctx);
    expect(spec.components.schemas).toMatchInlineSnapshot(`
      {
        "Obj": {
          "additionalProperties": false,
          "description": "obj",
          "properties": {},
          "type": "object",
        },
      }
    `);
});

it('should surface route descriptions & names', () => {
    const app = express();
    const router = express.Router();

    const ctx = d.newContext();
    d.addRouter(ctx, app, '', router);
    d.addGetRoute(
        ctx, router, '/pan',
        d.emptyFormat,
        async () => d.makeSuccessResponse({}),
        { summary: 'summary', description: 'description' }
    );
    const spec = d.docsFor(ctx);
    const path = spec.paths['/pan'].get;
    expect(path).toHaveProperty('description', 'description');
    expect(path).toHaveProperty('summary', 'summary');
});

it('should support optional query parameters', () => {
    const app = express();
    const router = express.Router();
    const ctx = d.newContext();
    d.addRouter(ctx, app, '', router);
    d.addGetRoute(
        ctx, router, '/test',
        { ...d.emptyFormat, query: z.object({ x: z.string(), y: z.optional(z.string()) }) },
        async () => d.makeSuccessResponse({}),
    );
    const spec = d.docsFor(ctx);
    const params = spec.paths['/test'].get?.parameters ?? [];
    expect(params[0].required).toEqual(true);
    expect(params[1].required).toEqual(false);
});

async function testCase(
    mode: 'get' | 'post',
    base: string,
    suffix: string,
    format: Partial<typeof d.emptyFormat>,
    correct: Partial<d.ExpressRequest>,
    incorrect: Partial<d.ExpressRequest>,
    validateCorrect: null | ((json: unknown) => unknown),
    validateIncorrect: null | ((error: string) => unknown),
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
            async (params, query) => d.makeSuccessResponse({ params, query })
        )
        : d.addPostRoute(
            ctx, router, suffix,
            { ...d.emptyFormat, ...format },
            async (params, query, body) => d.makeSuccessResponse({ params, query, body })
        );

    const defaultResponse: d.ExpressRequest = { query: {}, params: {}, body: {} };
    // correct value goes through?
    if (validateCorrect) {
        const res = await handler({ ...defaultResponse, ...correct });
        expect(res.status).toBe(200);
        validateCorrect(res.json);
    }

    // incorrect value is caught?
    if (validateIncorrect) {
        const res = await handler({ ...defaultResponse, ...incorrect });
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
