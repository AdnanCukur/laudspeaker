/* eslint-disable no-case-declarations */
import { Inject, Logger } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import {
  OnWorkerEvent,
} from '@nestjs/bullmq';
import { Job, MetricsTime, Queue } from 'bullmq';
import { StepType } from '../types/step.interface';
import { Step } from '../entities/step.entity';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Customer,
  CustomerDocument,
} from '@/api/customers/schemas/customer.schema';
import { Account } from '@/api/accounts/entities/accounts.entity';
import * as _ from 'lodash';
import * as Sentry from '@sentry/node';
import { JourneyLocationsService } from '@/api/journeys/journey-locations.service';
import { StepsService } from '../steps.service';
import { Journey } from '@/api/journeys/entities/journey.entity';
import { JourneyLocation } from '@/api/journeys/entities/journey-location.entity';
import { CacheService } from '@/common/services/cache.service';
import { Processor } from '@/common/services/queue/decorators/processor';
import { ProcessorBase } from '@/common/services/queue/classes/processor-base';
import { QueueType } from '@/common/services/queue/types/queue-type';
import { Producer } from '@/common/services/queue/classes/producer';

@Injectable()
@Processor('start.step')
export class StartStepProcessor extends ProcessorBase {
  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: Logger,
    @InjectModel(Customer.name) public customerModel: Model<CustomerDocument>,
    @Inject(JourneyLocationsService)
    private journeyLocationsService: JourneyLocationsService,
    @Inject(StepsService) private stepsService: StepsService,
    @Inject(CacheService) private cacheService: CacheService,
  ) {
    super();
  }

  log(message, method, session, user = 'ANONYMOUS') {
    this.logger.log(
      message,
      JSON.stringify({
        class: StartStepProcessor.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }
  debug(message, method, session, user = 'ANONYMOUS') {
    this.logger.debug(
      message,
      JSON.stringify({
        class: StartStepProcessor.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }
  warn(message, method, session, user = 'ANONYMOUS') {
    this.logger.warn(
      message,
      JSON.stringify({
        class: StartStepProcessor.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }
  error(error, method, session, user = 'ANONYMOUS') {
    this.logger.error(
      error.message,
      error.stack,
      JSON.stringify({
        class: StartStepProcessor.name,
        method: method,
        session: session,
        cause: error.cause,
        name: error.name,
        user: user,
      })
    );
  }
  verbose(message, method, session, user = 'ANONYMOUS') {
    this.logger.verbose(
      message,
      JSON.stringify({
        class: StartStepProcessor.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }

  async process(
    job: Job<
      {
        step: Step;
        owner: Account;
        journey: Journey;
        customer: CustomerDocument;
        location: JourneyLocation;
        session: string;
        event?: string;
        branch?: number;
        stepDepth: number;
      },
      any,
      string
    >
  ): Promise<any> {
    return Sentry.startSpan(
      { name: 'StartStepProcessor.process' },
      async () => {
        let nextJob;

        let nextStep: Step = await this.cacheService.getIgnoreError(
          Step,
          job.data.step.metadata.destination,
          async () => {
            return await this.stepsService.lazyFindByID(
              job.data.step.metadata.destination
            );
          }
        );

        if (nextStep) {
          const nextStepDepth: number =
            Producer.getNextStepDepthFromJob(job);

          if (
            nextStep.type !== StepType.TIME_DELAY &&
            nextStep.type !== StepType.TIME_WINDOW &&
            nextStep.type !== StepType.WAIT_UNTIL_BRANCH
          ) {
            nextJob = {
              owner: job.data.owner,
              journey: job.data.journey,
              step: nextStep,
              session: job.data.session,
              customer: job.data.customer,
              location: job.data.location,
              event: job.data.event,
              stepDepth: nextStepDepth,
            };
          } else {
            // Destination is time based,
            // customer has stopped moving so we can release lock
            await this.journeyLocationsService.unlock(
              job.data.location,
              nextStep
            );
          }
        } else {
          // Destination does not exist,
          // customer has stopped moving so we can release lock
          await this.journeyLocationsService.unlock(
            job.data.location,
            job.data.step
          );
        }
        if (nextStep && nextJob)
          await Producer.addByStepType(nextStep.type, nextJob);
      }
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error, prev?: string) {
    Sentry.withScope((scope) => {
      scope.setTag('job_id', job.id);
      scope.setTag('processor', StartStepProcessor.name);
      Sentry.captureException(error);
    });
  }
}
