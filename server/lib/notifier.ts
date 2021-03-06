import { UserNotificationSettingValue, UserNotificationType, UserRight } from '../../shared/models/users'
import { logger } from '../helpers/logger'
import { VideoModel } from '../models/video/video'
import { Emailer } from './emailer'
import { UserNotificationModel } from '../models/account/user-notification'
import { VideoCommentModel } from '../models/video/video-comment'
import { UserModel } from '../models/account/user'
import { PeerTubeSocket } from './peertube-socket'
import { CONFIG } from '../initializers/config'
import { VideoPrivacy, VideoState } from '../../shared/models/videos'
import { VideoAbuseModel } from '../models/video/video-abuse'
import { VideoBlacklistModel } from '../models/video/video-blacklist'
import * as Bluebird from 'bluebird'
import { VideoImportModel } from '../models/video/video-import'
import { AccountBlocklistModel } from '../models/account/account-blocklist'
import { ActorFollowModel } from '../models/activitypub/actor-follow'
import { AccountModel } from '../models/account/account'

class Notifier {

  private static instance: Notifier

  private constructor () {}

  notifyOnNewVideo (video: VideoModel): void {
    // Only notify on public and published videos which are not blacklisted
    if (video.privacy !== VideoPrivacy.PUBLIC || video.state !== VideoState.PUBLISHED || video.VideoBlacklist) return

    this.notifySubscribersOfNewVideo(video)
      .catch(err => logger.error('Cannot notify subscribers of new video %s.', video.url, { err }))
  }

  notifyOnVideoPublishedAfterTranscoding (video: VideoModel): void {
    // don't notify if didn't wait for transcoding or video is still blacklisted/waiting for scheduled update
    if (!video.waitTranscoding || video.VideoBlacklist || video.ScheduleVideoUpdate) return

    this.notifyOwnedVideoHasBeenPublished(video)
        .catch(err => logger.error('Cannot notify owner that its video %s has been published after transcoding.', video.url, { err }))
  }

  notifyOnVideoPublishedAfterScheduledUpdate (video: VideoModel): void {
    // don't notify if video is still blacklisted or waiting for transcoding
    if (video.VideoBlacklist || (video.waitTranscoding && video.state !== VideoState.PUBLISHED)) return

    this.notifyOwnedVideoHasBeenPublished(video)
        .catch(err => logger.error('Cannot notify owner that its video %s has been published after scheduled update.', video.url, { err }))
  }

  notifyOnVideoPublishedAfterRemovedFromAutoBlacklist (video: VideoModel): void {
    // don't notify if video is still waiting for transcoding or scheduled update
    if (video.ScheduleVideoUpdate || (video.waitTranscoding && video.state !== VideoState.PUBLISHED)) return

    this.notifyOwnedVideoHasBeenPublished(video)
        .catch(err => logger.error('Cannot notify owner that its video %s has been published after removed from auto-blacklist.', video.url, { err })) // tslint:disable-line:max-line-length
  }

  notifyOnNewComment (comment: VideoCommentModel): void {
    this.notifyVideoOwnerOfNewComment(comment)
        .catch(err => logger.error('Cannot notify video owner of new comment %s.', comment.url, { err }))

    this.notifyOfCommentMention(comment)
        .catch(err => logger.error('Cannot notify mentions of comment %s.', comment.url, { err }))
  }

  notifyOnNewVideoAbuse (videoAbuse: VideoAbuseModel): void {
    this.notifyModeratorsOfNewVideoAbuse(videoAbuse)
      .catch(err => logger.error('Cannot notify of new video abuse of video %s.', videoAbuse.Video.url, { err }))
  }

  notifyOnVideoAutoBlacklist (video: VideoModel): void {
    this.notifyModeratorsOfVideoAutoBlacklist(video)
      .catch(err => logger.error('Cannot notify of auto-blacklist of video %s.', video.url, { err }))
  }

  notifyOnVideoBlacklist (videoBlacklist: VideoBlacklistModel): void {
    this.notifyVideoOwnerOfBlacklist(videoBlacklist)
      .catch(err => logger.error('Cannot notify video owner of new video blacklist of %s.', videoBlacklist.Video.url, { err }))
  }

  notifyOnVideoUnblacklist (video: VideoModel): void {
    this.notifyVideoOwnerOfUnblacklist(video)
        .catch(err => logger.error('Cannot notify video owner of unblacklist of %s.', video.url, { err }))
  }

  notifyOnFinishedVideoImport (videoImport: VideoImportModel, success: boolean): void {
    this.notifyOwnerVideoImportIsFinished(videoImport, success)
      .catch(err => logger.error('Cannot notify owner that its video import %s is finished.', videoImport.getTargetIdentifier(), { err }))
  }

  notifyOnNewUserRegistration (user: UserModel): void {
    this.notifyModeratorsOfNewUserRegistration(user)
        .catch(err => logger.error('Cannot notify moderators of new user registration (%s).', user.username, { err }))
  }

  notifyOfNewUserFollow (actorFollow: ActorFollowModel): void {
    this.notifyUserOfNewActorFollow(actorFollow)
      .catch(err => {
        logger.error(
          'Cannot notify owner of channel %s of a new follow by %s.',
          actorFollow.ActorFollowing.VideoChannel.getDisplayName(),
          actorFollow.ActorFollower.Account.getDisplayName(),
          { err }
        )
      })
  }

  notifyOfNewInstanceFollow (actorFollow: ActorFollowModel): void {
    this.notifyAdminsOfNewInstanceFollow(actorFollow)
        .catch(err => {
          logger.error('Cannot notify administrators of new follower %s.', actorFollow.ActorFollower.url, { err })
        })
  }

  private async notifySubscribersOfNewVideo (video: VideoModel) {
    // List all followers that are users
    const users = await UserModel.listUserSubscribersOf(video.VideoChannel.actorId)

    logger.info('Notifying %d users of new video %s.', users.length, video.url)

    function settingGetter (user: UserModel) {
      return user.NotificationSetting.newVideoFromSubscription
    }

    async function notificationCreator (user: UserModel) {
      const notification = await UserNotificationModel.create({
        type: UserNotificationType.NEW_VIDEO_FROM_SUBSCRIPTION,
        userId: user.id,
        videoId: video.id
      })
      notification.Video = video

      return notification
    }

    function emailSender (emails: string[]) {
      return Emailer.Instance.addNewVideoFromSubscriberNotification(emails, video)
    }

    return this.notify({ users, settingGetter, notificationCreator, emailSender })
  }

  private async notifyVideoOwnerOfNewComment (comment: VideoCommentModel) {
    if (comment.Video.isOwned() === false) return

    const user = await UserModel.loadByVideoId(comment.videoId)

    // Not our user or user comments its own video
    if (!user || comment.Account.userId === user.id) return

    const accountMuted = await AccountBlocklistModel.isAccountMutedBy(user.Account.id, comment.accountId)
    if (accountMuted) return

    logger.info('Notifying user %s of new comment %s.', user.username, comment.url)

    function settingGetter (user: UserModel) {
      return user.NotificationSetting.newCommentOnMyVideo
    }

    async function notificationCreator (user: UserModel) {
      const notification = await UserNotificationModel.create({
        type: UserNotificationType.NEW_COMMENT_ON_MY_VIDEO,
        userId: user.id,
        commentId: comment.id
      })
      notification.Comment = comment

      return notification
    }

    function emailSender (emails: string[]) {
      return Emailer.Instance.addNewCommentOnMyVideoNotification(emails, comment)
    }

    return this.notify({ users: [ user ], settingGetter, notificationCreator, emailSender })
  }

  private async notifyOfCommentMention (comment: VideoCommentModel) {
    const extractedUsernames = comment.extractMentions()
    logger.debug(
      'Extracted %d username from comment %s.', extractedUsernames.length, comment.url,
      { usernames: extractedUsernames, text: comment.text }
    )

    let users = await UserModel.listByUsernames(extractedUsernames)

    if (comment.Video.isOwned()) {
      const userException = await UserModel.loadByVideoId(comment.videoId)
      users = users.filter(u => u.id !== userException.id)
    }

    // Don't notify if I mentioned myself
    users = users.filter(u => u.Account.id !== comment.accountId)

    if (users.length === 0) return

    const accountMutedHash = await AccountBlocklistModel.isAccountMutedByMulti(users.map(u => u.Account.id), comment.accountId)

    logger.info('Notifying %d users of new comment %s.', users.length, comment.url)

    function settingGetter (user: UserModel) {
      if (accountMutedHash[user.Account.id] === true) return UserNotificationSettingValue.NONE

      return user.NotificationSetting.commentMention
    }

    async function notificationCreator (user: UserModel) {
      const notification = await UserNotificationModel.create({
        type: UserNotificationType.COMMENT_MENTION,
        userId: user.id,
        commentId: comment.id
      })
      notification.Comment = comment

      return notification
    }

    function emailSender (emails: string[]) {
      return Emailer.Instance.addNewCommentMentionNotification(emails, comment)
    }

    return this.notify({ users, settingGetter, notificationCreator, emailSender })
  }

  private async notifyUserOfNewActorFollow (actorFollow: ActorFollowModel) {
    if (actorFollow.ActorFollowing.isOwned() === false) return

    // Account follows one of our account?
    let followType: 'account' | 'channel' = 'channel'
    let user = await UserModel.loadByChannelActorId(actorFollow.ActorFollowing.id)

    // Account follows one of our channel?
    if (!user) {
      user = await UserModel.loadByAccountActorId(actorFollow.ActorFollowing.id)
      followType = 'account'
    }

    if (!user) return

    if (!actorFollow.ActorFollower.Account || !actorFollow.ActorFollower.Account.name) {
      actorFollow.ActorFollower.Account = await actorFollow.ActorFollower.$get('Account') as AccountModel
    }
    const followerAccount = actorFollow.ActorFollower.Account

    const accountMuted = await AccountBlocklistModel.isAccountMutedBy(user.Account.id, followerAccount.id)
    if (accountMuted) return

    logger.info('Notifying user %s of new follower: %s.', user.username, followerAccount.getDisplayName())

    function settingGetter (user: UserModel) {
      return user.NotificationSetting.newFollow
    }

    async function notificationCreator (user: UserModel) {
      const notification = await UserNotificationModel.create({
        type: UserNotificationType.NEW_FOLLOW,
        userId: user.id,
        actorFollowId: actorFollow.id
      })
      notification.ActorFollow = actorFollow

      return notification
    }

    function emailSender (emails: string[]) {
      return Emailer.Instance.addNewFollowNotification(emails, actorFollow, followType)
    }

    return this.notify({ users: [ user ], settingGetter, notificationCreator, emailSender })
  }

  private async notifyAdminsOfNewInstanceFollow (actorFollow: ActorFollowModel) {
    const admins = await UserModel.listWithRight(UserRight.MANAGE_SERVER_FOLLOW)

    logger.info('Notifying %d administrators of new instance follower: %s.', admins.length, actorFollow.ActorFollower.url)

    function settingGetter (user: UserModel) {
      return user.NotificationSetting.newInstanceFollower
    }

    async function notificationCreator (user: UserModel) {
      const notification = await UserNotificationModel.create({
        type: UserNotificationType.NEW_INSTANCE_FOLLOWER,
        userId: user.id,
        actorFollowId: actorFollow.id
      })
      notification.ActorFollow = actorFollow

      return notification
    }

    function emailSender (emails: string[]) {
      return Emailer.Instance.addNewInstanceFollowerNotification(emails, actorFollow)
    }

    return this.notify({ users: admins, settingGetter, notificationCreator, emailSender })
  }

  private async notifyModeratorsOfNewVideoAbuse (videoAbuse: VideoAbuseModel) {
    const moderators = await UserModel.listWithRight(UserRight.MANAGE_VIDEO_ABUSES)
    if (moderators.length === 0) return

    logger.info('Notifying %s user/moderators of new video abuse %s.', moderators.length, videoAbuse.Video.url)

    function settingGetter (user: UserModel) {
      return user.NotificationSetting.videoAbuseAsModerator
    }

    async function notificationCreator (user: UserModel) {
      const notification = await UserNotificationModel.create({
        type: UserNotificationType.NEW_VIDEO_ABUSE_FOR_MODERATORS,
        userId: user.id,
        videoAbuseId: videoAbuse.id
      })
      notification.VideoAbuse = videoAbuse

      return notification
    }

    function emailSender (emails: string[]) {
      return Emailer.Instance.addVideoAbuseModeratorsNotification(emails, videoAbuse)
    }

    return this.notify({ users: moderators, settingGetter, notificationCreator, emailSender })
  }

  private async notifyModeratorsOfVideoAutoBlacklist (video: VideoModel) {
    const moderators = await UserModel.listWithRight(UserRight.MANAGE_VIDEO_BLACKLIST)
    if (moderators.length === 0) return

    logger.info('Notifying %s moderators of video auto-blacklist %s.', moderators.length, video.url)

    function settingGetter (user: UserModel) {
      return user.NotificationSetting.videoAutoBlacklistAsModerator
    }
    async function notificationCreator (user: UserModel) {

      const notification = await UserNotificationModel.create({
        type: UserNotificationType.VIDEO_AUTO_BLACKLIST_FOR_MODERATORS,
        userId: user.id,
        videoId: video.id
      })
      notification.Video = video

      return notification
    }

    function emailSender (emails: string[]) {
      return Emailer.Instance.addVideoAutoBlacklistModeratorsNotification(emails, video)
    }

    return this.notify({ users: moderators, settingGetter, notificationCreator, emailSender })
  }

  private async notifyVideoOwnerOfBlacklist (videoBlacklist: VideoBlacklistModel) {
    const user = await UserModel.loadByVideoId(videoBlacklist.videoId)
    if (!user) return

    logger.info('Notifying user %s that its video %s has been blacklisted.', user.username, videoBlacklist.Video.url)

    function settingGetter (user: UserModel) {
      return user.NotificationSetting.blacklistOnMyVideo
    }

    async function notificationCreator (user: UserModel) {
      const notification = await UserNotificationModel.create({
        type: UserNotificationType.BLACKLIST_ON_MY_VIDEO,
        userId: user.id,
        videoBlacklistId: videoBlacklist.id
      })
      notification.VideoBlacklist = videoBlacklist

      return notification
    }

    function emailSender (emails: string[]) {
      return Emailer.Instance.addVideoBlacklistNotification(emails, videoBlacklist)
    }

    return this.notify({ users: [ user ], settingGetter, notificationCreator, emailSender })
  }

  private async notifyVideoOwnerOfUnblacklist (video: VideoModel) {
    const user = await UserModel.loadByVideoId(video.id)
    if (!user) return

    logger.info('Notifying user %s that its video %s has been unblacklisted.', user.username, video.url)

    function settingGetter (user: UserModel) {
      return user.NotificationSetting.blacklistOnMyVideo
    }

    async function notificationCreator (user: UserModel) {
      const notification = await UserNotificationModel.create({
        type: UserNotificationType.UNBLACKLIST_ON_MY_VIDEO,
        userId: user.id,
        videoId: video.id
      })
      notification.Video = video

      return notification
    }

    function emailSender (emails: string[]) {
      return Emailer.Instance.addVideoUnblacklistNotification(emails, video)
    }

    return this.notify({ users: [ user ], settingGetter, notificationCreator, emailSender })
  }

  private async notifyOwnedVideoHasBeenPublished (video: VideoModel) {
    const user = await UserModel.loadByVideoId(video.id)
    if (!user) return

    logger.info('Notifying user %s of the publication of its video %s.', user.username, video.url)

    function settingGetter (user: UserModel) {
      return user.NotificationSetting.myVideoPublished
    }

    async function notificationCreator (user: UserModel) {
      const notification = await UserNotificationModel.create({
        type: UserNotificationType.MY_VIDEO_PUBLISHED,
        userId: user.id,
        videoId: video.id
      })
      notification.Video = video

      return notification
    }

    function emailSender (emails: string[]) {
      return Emailer.Instance.myVideoPublishedNotification(emails, video)
    }

    return this.notify({ users: [ user ], settingGetter, notificationCreator, emailSender })
  }

  private async notifyOwnerVideoImportIsFinished (videoImport: VideoImportModel, success: boolean) {
    const user = await UserModel.loadByVideoImportId(videoImport.id)
    if (!user) return

    logger.info('Notifying user %s its video import %s is finished.', user.username, videoImport.getTargetIdentifier())

    function settingGetter (user: UserModel) {
      return user.NotificationSetting.myVideoImportFinished
    }

    async function notificationCreator (user: UserModel) {
      const notification = await UserNotificationModel.create({
        type: success ? UserNotificationType.MY_VIDEO_IMPORT_SUCCESS : UserNotificationType.MY_VIDEO_IMPORT_ERROR,
        userId: user.id,
        videoImportId: videoImport.id
      })
      notification.VideoImport = videoImport

      return notification
    }

    function emailSender (emails: string[]) {
      return success
        ? Emailer.Instance.myVideoImportSuccessNotification(emails, videoImport)
        : Emailer.Instance.myVideoImportErrorNotification(emails, videoImport)
    }

    return this.notify({ users: [ user ], settingGetter, notificationCreator, emailSender })
  }

  private async notifyModeratorsOfNewUserRegistration (registeredUser: UserModel) {
    const moderators = await UserModel.listWithRight(UserRight.MANAGE_USERS)
    if (moderators.length === 0) return

    logger.info(
      'Notifying %s moderators of new user registration of %s.',
      moderators.length, registeredUser.Account.Actor.preferredUsername
    )

    function settingGetter (user: UserModel) {
      return user.NotificationSetting.newUserRegistration
    }

    async function notificationCreator (user: UserModel) {
      const notification = await UserNotificationModel.create({
        type: UserNotificationType.NEW_USER_REGISTRATION,
        userId: user.id,
        accountId: registeredUser.Account.id
      })
      notification.Account = registeredUser.Account

      return notification
    }

    function emailSender (emails: string[]) {
      return Emailer.Instance.addNewUserRegistrationNotification(emails, registeredUser)
    }

    return this.notify({ users: moderators, settingGetter, notificationCreator, emailSender })
  }

  private async notify (options: {
    users: UserModel[],
    notificationCreator: (user: UserModel) => Promise<UserNotificationModel>,
    emailSender: (emails: string[]) => Promise<any> | Bluebird<any>,
    settingGetter: (user: UserModel) => UserNotificationSettingValue
  }) {
    const emails: string[] = []

    for (const user of options.users) {
      if (this.isWebNotificationEnabled(options.settingGetter(user))) {
        const notification = await options.notificationCreator(user)

        PeerTubeSocket.Instance.sendNotification(user.id, notification)
      }

      if (this.isEmailEnabled(user, options.settingGetter(user))) {
        emails.push(user.email)
      }
    }

    if (emails.length !== 0) {
      await options.emailSender(emails)
    }
  }

  private isEmailEnabled (user: UserModel, value: UserNotificationSettingValue) {
    if (CONFIG.SIGNUP.REQUIRES_EMAIL_VERIFICATION === true && user.emailVerified === false) return false

    return value & UserNotificationSettingValue.EMAIL
  }

  private isWebNotificationEnabled (value: UserNotificationSettingValue) {
    return value & UserNotificationSettingValue.WEB
  }

  static get Instance () {
    return this.instance || (this.instance = new this())
  }
}

// ---------------------------------------------------------------------------

export {
  Notifier
}
