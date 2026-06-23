# use Node imas
FROM node:20

# setup work dir
WORKDIR /app

# cp package.json and lock file
COPY package*.json ./

# install
RUN npm install

# copy code
COPY . .

RUN npm run build

RUN npm install -g pm2

EXPOSE 3000

# start service
CMD ["pm2-runtime", "dist/app.js", "-i", "max"]