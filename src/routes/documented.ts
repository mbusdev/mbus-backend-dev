/**
 * Wrappers around stuff you would otherwise do with express but with reflection
 * capabilities used for openapi specification generation.
 *
 * The `req` and `res` objects aren't provided to the passed in handler
 * functions, if you're doing something more complicated just use the router
 * directly for now.
 *
 * Nested routing not supported yet, but should probably be added since api.ts
 * is getting long (or we could separate the functions from the route defintions?).
 *
 * Extra functionality can be added as needed.
 *
 * EXAMPLES: 
 *
 * TODO: post support [done?]
 * TODO: add examples
 * TODO: support empty request and response bodies
 * TODO: make actually testable?
 * TODO: add tests?
 */

import express from 'express';
import z from 'zod';
import { JSONSchema, ToJSONSchemaParams } from 'zod/v4/core';

/** is reflection enabled? */
export const reflection = true;

// === interface for people defining apis ===

export function addRouter(app: express.Express, route: string, router: express.Router) {
    if (reflection) {
        info.routers.push({ route, router });
    }
    app.use(route, router);
}

/**
 * feel free to add more codes here and to the make*[a-z]Response functions as you need them
 */
export type HandlerReturn<T> = {
    success: true, status: 200 | 201 | 202 | 203 | 205, json: T
} | {
    success: false, status: 400 | 401 | 403 | 404 | 500, error: string
};

/**
 * helper function that should avoid weird typechecker issues
 */
export function makeSuccessResponse<T>(status: 200 | 201 | 202 | 203 | 205, json: T): HandlerReturn<T> {
    return { success: true, status, json };
}

/**
 * helper function that should avoid weird typechecker issues
 */
export function makeFailureResponse<T>(status: 400 | 401 | 403 | 404 | 500, error: string): HandlerReturn<T> {
    return { success: false, status, error };
}

/** z.object({ example: z.(...), hello: z.number(), ... }) */
export type StandardZodObject = z.ZodObject<Record<string, z.ZodType>>;

export const emptyFormat = {
    params: z.object(), query: z.object(), reqBody: z.unknown(), resBody: z.unknown(),
};

/**
 * wrapper around router.get with built in validation and schema recording
 *
 * the `req` and `res` objects aren't provided to the passed in handler, if
 * you're doing something more complicated just use the router directly for
 * now, the functionality needed will be incorporated
 *
 * type parameters
 * - P: path params
 * - Q: query params
 * - RB: response body
 */
export function addGetRoute<
    P extends StandardZodObject,
    Q extends StandardZodObject,
    RB extends z.ZodType
>(
    router: express.Router,
    path: string,
    format: { params: P, query: Q, resBody: RB },
    handler: (params: z.infer<P>, query: z.infer<Q>) => HandlerReturn<z.infer<RB>>,
    docs?: {
        /** a short description of what is route does, becomes the title */
        summary?: string,
        /** a longer explanation, commonmark accepted */
        description?: string,
    },
) {
    const { params: paramsSchema, query: querySchema, resBody: resBodySchema } = format;

    if (reflection) {
        info.routes.push({
            router, method: 'get',
            pathSuffix: path,
            params: paramsSchema.shape,
            query: querySchema.shape,
            resBody: resBodySchema instanceof z.ZodUnknown ? null : resBodySchema,
            summary: docs?.summary ?? "", description: docs?.description ?? "",
        });
    }

    router.get(path, (req: express.Request, res: express.Response<z.infer<RB> | { error: string }>) => {
        const { status, json } = determineResponse(req);
        res.status(status).json(json);
    });

    const determineResponse = (req: express.Request): { status: number, json: z.infer<RB> | { error: string } } => {
        let params = paramsSchema.safeParse(req.params);
        if (params.error) {
            return { status: 400, json: { error: "invalid path params: " + params.error.message } };
        }
        let query = querySchema.safeParse(req.query);
        if (query.error) {
            return { status: 400, json: { error: "invalid query params: " + query.error.message } };
        }
        try {
            const result = handler(params.data, query.data);
            if (result.success) {
                return { status: result.status, json: result.json };
            } else {
                return { status: result.status, json: { error: result.error } };
            }
        } catch (e) {
            console.error(`uncaught exception in wrapped route: ${e}`)
            if (e instanceof Error) {
                return { status: 500, json: { error: e.message } }
            } else {
                return { status: 500, json: { error: JSON.stringify(e) } }
            }
        }
    }
}

/**
 * wrapper around router.post with built in validation and schema recording
 *
 * the `req` and `res` objects aren't provided to the passed in handler, if
 * you're doing something more complicated just use the router directly for
 * now, the functionality needed will be incorporated
 *
 * type parameters
 * - P: path params
 * - Q: query params
 * - B: request body
 * - RB: response body
 */
export function addPostRoute<
    P extends StandardZodObject,
    Q extends StandardZodObject,
    B extends z.ZodType,
    RB extends z.ZodType,
>(
    router: express.Router,
    path: string,
    format: { params: P, query: Q, reqBody: B, resBody: RB },
    handler: (params: z.infer<P>, query: z.infer<Q>, body: z.infer<B>) => HandlerReturn<z.infer<RB>>,
    docs?: {
        /** a short description of what is route does, becomes the title */
        summary?: string,
        /** a longer explanation, commonmark accepted */
        description?: string,
    },
) {
    const { params: paramsSchema, query: querySchema, reqBody: reqBodySchema, resBody: resBodySchema } = format;

    if (reflection) {
        info.routes.push({
            router, method: 'post', pathSuffix: path,
            params: paramsSchema.shape,
            query: querySchema.shape,
            reqBody: reqBodySchema instanceof z.ZodUnknown ? null : reqBodySchema,
            resBody: resBodySchema instanceof z.ZodUnknown ? null : resBodySchema,
            summary: docs?.summary ?? "", description: docs?.description ?? "",
        });
    }

    router.post(path, (req, res: express.Response<z.infer<RB> | { error: string }>) => {
        const { status, json } = determineResponse(req);
        res.status(status).json(json);
    });

    const determineResponse = (req: express.Request): { status: number, json: z.infer<RB> | { error: string } } => {
        let params = paramsSchema.safeParse(req.params);
        if (params.error) {
            return { status: 400, json: { error: "invalid path params: " + params.error.message } };
        }
        let query = querySchema.safeParse(req.query);
        if (query.error) {
            return { status: 400, json: { error: "invalid query params: " + query.error.message } };
        }
        let body = reqBodySchema.safeParse(req.body);
        if (body.error) {
            return { status: 400, json: { error: "invalid body: " + body.error.message } };
        }
        try {
            const result = handler(params.data, query.data, body.data);
            if (result.success) {
                return { status: result.status, json: result.json };
            } else {
                return { status: result.status, json: { error: result.error } };
            }
        } catch (e) {
            console.error(`uncaught exception in wrapped route: ${e}`)
            if (e instanceof Error) {
                return { status: 500, json: { error: e.message } }
            } else {
                return { status: 500, json: { error: JSON.stringify(e) } }
            }
        }
    }
}

// === end of interface for api defining ===

const info: ReflectionInfoRaw = {
    routers: [],
    routes: []
};

/**
 * doc descriptions passed as data in summary and description fields
 */
interface ReflectionInfoRaw {
    routers: Array<{ route: string, router: express.Router }>,
    /** full routes along with req+res schemas, routes are incomplete until info is finalized */
    routes: Array<{
        router: express.Router,
        pathSuffix: string,
        summary: string,
        description: string,
        params: Record<string, z.ZodType>,
        query: Record<string, z.ZodType>,
        resBody: z.ZodType | null,
    } & ({ method: 'get' } | { method: 'post', reqBody: z.ZodType | null })>,
};

interface ReflectionInfo {
    routes: Array<{
        path: string,
        summary: string,
        description: string,
        params: Record<string, JSONSchema.JSONSchema>,
        query: Record<string, JSONSchema.JSONSchema>,
        resBody: JSONSchema.BaseSchema | null,
    } & ({ method: 'get' } | { method: 'post', reqBody: JSONSchema.BaseSchema | null })>,
    defs: Record<string, JSONSchema.JSONSchema>,
};

interface OpenAPIPathCommon {
    summary: string,
    description: string,
    parameters: Array<{
        name: string,
        in: "path" | "query",
        schema: JSONSchema.JSONSchema,
        required: boolean,
    }>,
    responses: {
        "2XX": {
            description: "success",
            content?: {
                "application/json": {
                    schema: JSONSchema.JSONSchema,
                }
            }
        }
    },
};

interface OpenAPIGetPath extends OpenAPIPathCommon { };

interface OpenAPIPostPath extends OpenAPIPathCommon {
    requestBody?: {
        content: {
            "application/json": {
                schema: JSONSchema.JSONSchema,
            }
        },
        required: boolean,
    },
};

/** the subset of the openapi format(s) we are concerned with generating */
interface OpenAPI {
    openapi: "3.1.2",
    info: {
        title: string,
        version: string,
    },
    components: {
        schemas: Record<string, JSONSchema.JSONSchema>,
    },
    paths: Record<string, { get?: OpenAPIGetPath, post?: OpenAPIPostPath }/*Record<"get", OpenAPIGetPath>*/>,
}

function finalize(info: ReflectionInfoRaw): ReflectionInfo {
    // replace $def with components/schemas
    const fixSchema = <T>(s: T): T => {
        if (typeof s !== 'object' || !s) return s;
        if ('$ref' in s && typeof s.$ref == 'string')
            s.$ref = s.$ref.replace('$defs', 'components/schemas');
        for (const v of Object.values(s)) {
            fixSchema(v);
        }
        return s;
    };

    // TODO: try output first then fallback to input
    const schemaOpts: ToJSONSchemaParams = {
        // reused: 'ref',
        io: 'input',
    }
    const resultRoutes: ReflectionInfo['routes'] = [];

    // used to get the shared $defs
    const model: Record<string, z.ZodType> = {};

    for (const route of info.routes) {
        const basePath = info.routers.find((r) => r.router == route.router)?.route;
        if (basePath == undefined) {
            throw new Error('route has missing base path');
        }
        const path = (basePath + route.pathSuffix).replace(/:([A-Za-z0-9_]+)/, "{$1}");
        const finalParams: Record<string, JSONSchema.JSONSchema> = {};
        for (const param in route.params) {
            const zodSchema = route.params[param];
            model[path + ' params ' + param] = zodSchema;
            finalParams[param] = fixSchema(zodSchema.toJSONSchema(schemaOpts));
        }
        const finalQuery: Record<string, JSONSchema.JSONSchema> = {};
        for (const key in route.query) {
            const zodSchema = route.query[key];
            model[path + '?' + key] = zodSchema;
            finalQuery[key] = fixSchema(zodSchema.toJSONSchema(schemaOpts));
        }
        const common = {
            path,
            params: finalParams,
            query: finalQuery,
            resBody: route.resBody === null ? null : fixSchema(route.resBody.toJSONSchema(schemaOpts)),
            summary: route.summary,
            description: route.description,
        };
        switch (route.method) {
            case 'get':
                resultRoutes.push({ ...common, method: 'get' });
                break;
            case 'post':
                resultRoutes.push({
                    ...common,
                    method: 'post',
                    reqBody: route.reqBody === null ? null : fixSchema(route.reqBody.toJSONSchema(schemaOpts)),
                });
                if (route.reqBody)
                    model[path + ' reqBody'] = route.reqBody;
                break;
            default:
                // TODO: use eslint exhaustiveness checking
                const _: never = route;
        }
        if (route.resBody)
            model[path + ' resBody'] = route.resBody;
    }
    return {
        routes: resultRoutes,
        defs: fixSchema(z.object(model).toJSONSchema(schemaOpts)).$defs ?? {},
    };
}

function makeOpenAPI(info: ReflectionInfo): OpenAPI {
    const pathsArray = info.routes
        .map((route): { url: string } & (
            { method: 'get', path: OpenAPIGetPath } | { method: 'post', path: OpenAPIPostPath }
        ) => {
            const parameters: OpenAPIGetPath['parameters'] = [];
            for (const name in route.params) {
                parameters.push({ name: name, in: 'path', required: true, schema: route.params[name] });
            }
            for (const name in route.query) {
                parameters.push({ name: name, in: 'query', required: true, schema: route.query[name] });
            }
            const content = route.resBody === null
                ? undefined
                : { 'application/json': { schema: route.resBody } };
            const responses: OpenAPIGetPath['responses'] = {
                '2XX': {
                    description: 'success',
                    content,
                }
            };
            const common: OpenAPIPathCommon = {
                summary: route.summary,
                description: route.description,
                parameters,
                responses,
            };
            switch (route.method) {
                case 'get':
                    return { url: route.path, method: 'get', path: common };
                case 'post':
                    const requestBody = route.reqBody == null
                        ? undefined
                        : { content: { "application/json": { schema: route.reqBody } }, required: true };
                    return {
                        url: route.path, method: 'post', path: {
                            requestBody, ...common
                        }
                    };
            }
        });
    const paths: OpenAPI['paths'] = {};
    for (const { url, method, path } of pathsArray) {
        if (!paths[url]) paths[url] = {};
        if (method === 'get')
            paths[url].get = path;
        else
            paths[url].post = path;
    }
    return {
        openapi: "3.1.2",
        info: {
            title: "Maize Bus Backend",
            version: "",
        },
        components: { schemas: info.defs },
        paths,
    }
}

export function dumpReflectionInfo() {
    const finalized = finalize(info);
    const openAPI = makeOpenAPI(finalized);
    console.log(JSON.stringify(openAPI, null, 4));
}

