import readline from 'readline/promises';

import { simpleGit } from 'simple-git';

type Config = {
    baseBranch: string,
    outputBranch: string,
    actions: Action[],
}

type Action = { of: 'merge', branch: string } | { of: 'patch', file: string };

function merge(branch: string): Action {
    return { of: 'merge', branch };
}

function patch(file: string): Action {
    return { of: 'patch', file };
}

const mockBe2: Config = {
    baseBranch: 'dev',
    outputBranch: 'mock-backend-2-test',
    actions: [
        merge('turn-by-turn-and-walk-rerouting'),
        merge('mock-floor-plans-visuals'),
        merge('nav/plan-journey-bus-polylines'),
        merge('mock-turn-by-turn'),
        patch('../mock-be-patches/eliminate_duplicate.diff'),
        merge('plan-journey-field-removal'),
        merge('origin/hadley-wv-hotfix'),
    ]
};

const staging1: Config = {
    baseBranch: 'staging/base',
    outputBranch: 'staging/1',
    actions: [
        merge('origin/dev'),
    ]
}

const staging2: Config = {
    baseBranch: 'staging/1',
    outputBranch: 'staging/2',
    actions: [
        merge('origin/hadley-wv-hotfix'),
        merge('origin/turn-by-turn-and-walk-rerouting'),
        merge('origin/plan-journey-field-removal'),
    ]
}

const develop1: Config = {
    baseBranch: 'staging/2',
    outputBranch: 'develop/1',
    actions: [
        // TODO: dev floor plans route
    ]
}

const configs = [staging1, staging2, develop1];

async function apply(config: Config) {
    const rl = readline.createInterface(process.stdin, process.stdout);
    const git = simpleGit();

    if ((await git.diffSummary()).changed > 0) {
        console.log('working tree is not clean, aborting');
        process.exit(1);
    }
    await git.checkout(['--detach', config.baseBranch]);
    for (const action of config.actions) {
        switch (action.of) {
            case 'merge':
                console.log('merging ' + action.branch);
                let done = false;
                let ans = 'r';
                while (!done) {
                    try {
                        if (ans == 'r') {
                            const res = await git.merge(['--no-edit', '--rerere-autoupdate', action.branch]);
                            if (res.conflicts.length > 0) throw new Error('merge conflict');
                            done = true;
                        } else if (ans == 'c') {
                            const res = await git.merge(['--continue']);
                            if (res.conflicts.length > 0) throw new Error('merge conflict');
                            done = true;
                        } else {
                            throw new Error('invalid option');
                        }
                    } catch (e) {
                        console.log((e as Error).message ?? e);
                        ans = await rl.question('encountered issue, please fix then [r(etry)/c(ontinue)]\n');
                    }
                }
                break;   
            case 'patch':
                console.log('applying patch ' + action.file);
                console.log(await git.raw(['am', action.file]));
                break;
            default:
                const _: never = action;
        }
    }
    await git.checkout(['-B', config.outputBranch]);
    await git.reset(['HEAD@{1}']);
    console.log('done');
}

async function applyAll() {
    for (const config of configs) {
        console.log('applying config');
        await apply(config);
    }
}

applyAll();
