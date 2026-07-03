/**
 * Wrappers around stuff you would otherwise do with express but with reflection
 * capabilities used for openapi specification generation.
 *
 * The `req` and `res` objects aren't provided to the passed in handler
 * functions, if you're doing something more complicated just use the router
 * directly for now.
 *
 * Nested routing not supported yet, but should probably be added since api.ts
 * is getting long.
 *
 * Extra functionality will be added as needed.
 *
 * TODO: add examples
 * TODO: add tests
 * TODO: use doc info, generate docs
 * TODO: convert path acceptors from express format to openapi format
 */

import express from 'express';
import z from 'zod';
import { JSONSchema, ToJSONSchemaParams } from 'zod/v4/core';

/** is reflection enabled? */
export const reflection = true;
const info: ReflectionInfoRaw = {
    routers: [],
    routes: []
};

/**
 * unresolved: how to get descriptions from the ts-doc comments?
 * probably handled by a typedoc plugin, or passed directly
 */
interface ReflectionInfoRaw {
    routers: Array<{ route: string, router: express.Router }>,
    /** full routes along with req+res schemas, routes are incomplete until info is finalized */
    routes: Array<{
        router: express.Router,
        pathSuffix: string,
        method: 'get',
        params: z.ZodType,
        query: z.ZodType,
        resBody: z.ZodType,
    }>,
};

interface ReflectionInfo {
    routes: Array<{
        path: string, method: 'get',
        params: JSONSchema.BaseSchema, query: JSONSchema.BaseSchema, resBody: JSONSchema.BaseSchema,
    }>,
    model: JSONSchema.BaseSchema,
};

function finalize(info: ReflectionInfoRaw): ReflectionInfo {
    // TODO: try output first then fallback to input
    const schemaOpts: ToJSONSchemaParams = {
        reused: 'ref',
        io: 'input',
    }
    const resultRoutes = [];
    const model: Record<string, z.ZodType> = {};
    for (const route of info.routes) {
        const basePath = info.routers.find((r) => r.router == route.router)?.route;
        if (basePath == undefined) {
            throw new Error('route has missing base path');
        }
        const path = basePath + route.pathSuffix;
        resultRoutes.push({
            path, method: route.method,
            params: route.params.toJSONSchema(schemaOpts),
            query: route.query.toJSONSchema(schemaOpts),
            resBody: route.resBody.toJSONSchema(schemaOpts),
        });
        model[path + ' params'] = route.params;
        model[path + ' query'] = route.query;
        model[path + ' resBody'] = route.resBody;
    }
    return {
        routes: resultRoutes,
        model: z.object(model).toJSONSchema(schemaOpts),
    };
}

export function dumpReflectionInfo() {
    const finalized = finalize(info);
    console.log(JSON.stringify(finalized, null, 4));
}

export function addRouter(app: express.Express, route: string, router: express.Router) {
    if (reflection) {
        info.routers.push({ route, router });
    }
    app.use(route, router);
}

export interface GetFormat<
    P extends z.ZodType,
    Q extends z.ZodType,
    RB extends z.ZodType
> {
    /** path parameters */
    params: P,
    query: Q,
    resBody: RB,
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
 * helper functions that should avoid weird typechecker issues
 */
export function makeSuccessResponse<T>(status: 200 | 201 | 202 | 203 | 205, json: T): HandlerReturn<T> {
    return { success: true, status, json };
}

/**
 * helper functions that should avoid weird typechecker issues
 */
export function makeFailureResponse<T>(status: 400 | 401 | 403 | 404 | 500, error: string): HandlerReturn<T> {
    return { success: false, status, error };
}

/**
 * wrapper around router.get with built in validation and schema recording
 *
 * the `req` and `res` objects aren't provided to the passed in handler, if
 * you're doing something more complicated just use the router direclty for
 * now, the functionality needed will be incorporated
 */
export function addGetRoute<
    P extends z.ZodType,
    Q extends z.ZodType,
    RB extends z.ZodType
>(
    router: express.Router,
    path: string,
    format: GetFormat<P, Q, RB>,
    handler: (params: z.infer<P>, query: z.infer<Q>) => HandlerReturn<z.infer<RB>>,
    docs?: {
        /** a short description of what is route does */
        summary?: string,
        /** a longer explanation, commonmark accepted */
        description?: string,
    },
) {
    const { params: paramsSchema, query: querySchema, resBody: resBodySchema } = format;

    if (reflection) {
        info.routes.push({
            router, method: 'get', pathSuffix: path,
            params: paramsSchema, query: querySchema, resBody: resBodySchema,
        })
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
 * TODO: make this
 */
