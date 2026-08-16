import { spawn } from 'node:child_process';
import cron from 'node-cron';

const launchChild = () => spawn('npm', ['run', 'start'], { stdio: 'inherit' });

// start it now
let child = launchChild();

// restart task
cron.schedule("50 59 23 * * *", () => {
    child.kill('SIGINT');
    child.once('exit', () => {
        // wait 20s for mock bustime servers to update
        setTimeout(() => {
            // restart
            console.log('restarting...');
            child = launchChild();
        }, 20000) ;
    });
}, { timezone: 'Etc/GMT+5'});

