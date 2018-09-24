//
// Code Signing
//
// Copyright © 2018 Province of British Columbia
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Created by Jason Leach on 2018-01-10.
//

/* eslint-env es6 */

'use strict';

import {
  logger,
  putObject,
  isExpired,
  getObject,
  statObject,
  asyncMiddleware,
  errorWithCode,
} from '@bcgov/nodejs-common-utils';
import url from 'url';
import { PassThrough } from 'stream';
import fs from 'fs';
import request from 'request-promise-native';
import { Router } from 'express';
import multer from 'multer';
import config from '../../config';
import { cleanup } from '../../libs/utils';
import DataManager from '../../libs/db';
import shared from '../../libs/shared';

const router = new Router();
const dm = new DataManager();
const { db, Job } = dm;
const upload = multer({ dest: config.get('temporaryUploadPath') });
const bucket = config.get('minio:bucket');

router.post(
  '/',
  upload.single('file'),
  asyncMiddleware(async (req, res) => {
    const { platform } = req.query;

    if (!platform || !['ios', 'android'].includes(platform.toLocaleLowerCase())) {
      throw errorWithCode('Invalid platform parameter.', 400);
    }

    if (!req.file) {
      throw errorWithCode('To file attachment found.', 400);
    }

    /* This is the document format from multer:
  {
    destination: "uploads"
    encoding: "7bit",
    fieldname: "file",
    filename: "77ab791eb4af8f823c8d783fec03b7af",
    mimetype: "application/octet-stream",
    originalname: "SecureImage-20180531.zip",
    path: "uploads/77ab791eb4af8f823c8d783fec03b7af",
    size: 163501760,
  }
  */

    try {
      const fpath = req.file.path;
      fs.access(fpath, fs.constants.R_OK, err => {
        if (err) {
          const message = 'Unable to access uploaded package';
          logger.error(`${message}, , error = ${err.message}`);
          throw errorWithCode(message, 501);
        }
      });

      const readStream = fs.createReadStream(req.file.path);
      const etag = await putObject(shared.minio, bucket, req.file.originalname, readStream);

      if (etag) {
        await cleanup(req.file.path);
      }

      const job = await Job.create(db, {
        originalFileName: req.file.originalname,
        platform: platform.toLocaleLowerCase(),
        originalFileEtag: etag,
        status: 'Created',
      });
      logger.info(`Created job with ID ${job.id}`);

      const options = {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await shared.sso.accessToken}`,
        },
        method: 'POST',
        uri: url.resolve(config.get('agent:hostUrl'), config.get('agent:signPath')),
        body: { ...job, ...{ ref: url.resolve(config.get('apiUrl'), `/api/v1/job/${job.id}`) } },
        json: true,
      };
      const status = await request(options);

      if (status !== 'OK') {
        throw errorWithCode(`Unable to send job ${job.id} to agent`, 500);
      }

      res.status(202).json({ id: job.id }); // Accepted

      return null;
    } catch (err) {
      if (err.code) {
        throw err;
      }

      const message = 'Unable to create signing job';
      logger.error(`${message}, err = ${err.message}`);
      throw errorWithCode(`${message}, err = ${err.message}`, 500);
    }
  })
);

router.get(
  '/:jobId/download',
  asyncMiddleware(async (req, res) => {
    const { jobId } = req.params;
    const expirationInDays = config.get('expirationInDays');

    try {
      const job = await Job.findById(db, jobId);
      const stat = await statObject(shared.minio, bucket, job.deliveryFileName);

      if (isExpired(stat, expirationInDays)) {
        throw errorWithCode('This artifact is expired', 400);
      }

      const obj = await getObject(shared.minio, bucket, job.deliveryFileName);
      const bstream = new PassThrough().end(obj);

      const [name] = job.originalFileName.split('.');
      res.set({
        'Content-Disposition': `attachment;filename=${name}-signed.zip`,
        'Content-Type': 'application/zip',
        'Content-Length': obj.byteLength,
      });

      bstream.pipe(res);

      // const link = await presignedGetObject(shared.minio, bucket, job.deliveryFileName, 30);
      // res.redirect(link);
    } catch (error) {
      if (error.code) {
        throw error;
      }

      const message = `Unable to retrieve arcive for job with ID ${jobId}`;
      logger.error(`${message}, err = ${error.message}`);
      throw errorWithCode(`${message}, err = ${error.message}`, 500);
    }
  })
);

module.exports = router;
