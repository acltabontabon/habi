/**
 * The review request on the Git host, as last read. Habi asks the host only
 * when the user clicks "Check status" (through `gh`/`glab`), and says when it
 * last did. Comments are other people's words: shown as plain text, with no
 * links followed and no Markdown rendered. Replying, resolving and merging
 * stay on the host.
 */
import type { Contribution } from "../../bindings/Contribution";
import type { ReviewComment } from "../../bindings/ReviewComment";
import { Icon } from "../../components/Icon";
import { Button, Section, Status } from "../../components/ui";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { hostName, requestWord } from "../../lib/skills";

export function CommentItem({ comment }: { comment: ReviewComment }) {
  return (
    <li className="review-comment">
      <p className="review-comment-head">
        <strong>{comment.author}</strong>
        {comment.verdict === "approved" ? <Status tone="ok">approved</Status> : null}
        {comment.verdict === "changesRequested" ? <Status tone="warn">requested changes</Status> : null}
        {comment.path ? (
          <span className="mono muted">
            {comment.path}
            {comment.line ? `:${comment.line}` : ""}
          </span>
        ) : null}
        {comment.outdated ? <Status tone="muted">outdated</Status> : null}
        <span className="muted">{relativeTime(comment.createdAt)}</span>
      </p>
      {comment.body ? <p className="review-comment-body">{comment.body}</p> : null}
    </li>
  );
}

/** Inline comments for one file, shown with its diff. */
export function FileComments({ comments }: { comments: ReviewComment[] }) {
  if (comments.length === 0) return null;
  return (
    <ul className="review-comments review-comments-file" aria-label="Review comments on this file">
      {comments.map((c, i) => (
        <CommentItem key={i} comment={c} />
      ))}
    </ul>
  );
}

export function ReviewPanel({
  contribution: c,
  busy,
  onCheck,
  onRevise,
}: {
  contribution: Contribution;
  busy: string | null;
  onCheck: () => void;
  onRevise: () => void;
}) {
  const review = c.review;
  const host = hostName(c);
  const word = requestWord(c);
  const finished = review?.state === "merged" || review?.state === "closed";
  const url = review?.url ?? c.publishedUrl;
  const canAsk = !c.remote?.onThisMachine && !c.remote?.requestUnavailable;
  const general = (review?.comments ?? []).filter((x) => x.kind !== "inline");
  const inline = (review?.comments ?? []).filter((x) => x.kind === "inline");

  return (
    <Section
      title="Review"
      id="review"
      aside={
        <div className="review-actions">
          {url ? (
            <Button variant="quiet" size="sm" icon="external" onClick={() => void api.openExternal(url)}>
              Open on {host}
            </Button>
          ) : null}
          {canAsk ? (
            <Button size="sm" icon="refresh" busy={busy === "check"} onClick={onCheck}>
              Check status
            </Button>
          ) : null}
        </div>
      }
    >
      {!canAsk ? (
        <p className="muted">
          {c.remote?.requestUnavailable ?? "Habi cannot reach a Git host for this library."} Review happens
          wherever your team looks at the branch.
        </p>
      ) : review ? (
        <>
          <p className="muted">
            {host} {word} #{review.number}, checked {relativeTime(review.checkedAt)}. Habi reads this only
            when you ask.
          </p>
          {review.approvedBy.length > 0 ? (
            <p>
              <Status tone="ok">Approved</Status> by {review.approvedBy.join(", ")}
            </p>
          ) : null}
          {review.comments.length === 0 ? (
            <p className="muted">No comments yet.</p>
          ) : (
            <>
              <p className="muted">Comments are shown as plain text, exactly as written. Reply on {host}.</p>
              {general.length > 0 ? (
                <ul className="review-comments" aria-label="Review comments">
                  {general.map((x, i) => (
                    <CommentItem key={i} comment={x} />
                  ))}
                </ul>
              ) : null}
              {inline.length > 0 ? (
                <p className="muted">
                  <Icon name="file" size={13} /> {inline.length} comment{inline.length === 1 ? "" : "s"} on
                  specific lines — shown with the files below.
                </p>
              ) : null}
              {review.commentsTruncated ? (
                <p className="muted">More comments exist than Habi shows; open the request to see all.</p>
              ) : null}
            </>
          )}
        </>
      ) : (
        <p className="muted">
          Habi has not asked {host} about this {word} yet. {c.publishedNote ? `${c.publishedNote} ` : ""}
          Checking reads its state and comments with your{" "}
          {host === "GitLab" ? "glab" : host === "GitHub" ? "gh" : "gh or glab"} sign-in; nothing is sent.
        </p>
      )}

      {c.state !== "draft" && !finished ? (
        <div className="review-revise">
          <p>
            Need to change something after review?{" "}
            {c.origin.type === "localSkill"
              ? "Edit the skill in My skills first; revising copies it again."
              : c.origin.type === "projectSkill"
                ? "Edit the skill in the project first; revising copies it again."
                : "Revising reopens the form below."}{" "}
            The new version goes to the same branch{url ? ` and the same ${word}` : ""}.
          </p>
          <Button
            variant={review?.state === "changesRequested" ? "primary" : "secondary"}
            icon="pencil"
            busy={busy === "revise"}
            onClick={onRevise}
          >
            Revise…
          </Button>
        </div>
      ) : null}
      {finished ? (
        <p className="muted">
          This {word} is {review?.state === "merged" ? "merged" : "closed"}. To change the skill further,
          share it again as a new contribution.
        </p>
      ) : null}
    </Section>
  );
}
