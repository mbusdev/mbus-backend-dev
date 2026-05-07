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

# expose import
EXPOSE 3000

# start service
CMD ["npm", "start"]