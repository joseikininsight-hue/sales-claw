import Image from 'next/image';
import { ThemeToggle } from './theme-toggle';
import {
  ArrowRight,
  BarChart3,
  Bot,
  Building2,
  Check,
  CheckCircle2,
  Clock3,
  Code2,
  Database,
  Download,
  FileCheck2,
  LineChart,
  MailCheck,
  Menu,
  MonitorCheck,
  ShieldCheck,
  Users,
} from 'lucide-react';

type IconProps = {
  className?: string;
};

const navItems = ['機能', '料金', '使い方', '導入事例', 'よくある質問', 'ドキュメント'];

const reasonCards = [
  {
    title: 'AIで企業分析＆提案文を自動生成',
    body: 'ターゲット企業を分析し、パーソナライズされた提案文を作成。',
    icon: FileCheck2,
  },
  {
    title: 'フォーム入力を自動化',
    body: 'Playwrightが正確にフォームを入力。手作業の時間を大幅に削減。',
    icon: MonitorCheck,
  },
  {
    title: '人の承認を残す安全設計',
    body: '送信前に必ず人が確認。誤送信や炎上リスクを防ぎます。',
    icon: ShieldCheck,
  },
  {
    title: 'データで成果を可視化',
    body: '送信状況や反応をダッシュボードで確認。改善サイクルを高速化。',
    icon: BarChart3,
  },
];

const workflowSteps = [
  {
    title: '企業分析・リスト作成',
    body: 'AIが企業情報を収集・分析し、アプローチリストを自動生成。',
    icon: Building2,
  },
  {
    title: 'メッセージ生成',
    body: '企業ごとに最適化されたパーソナライズメッセージを生成。',
    icon: Bot,
  },
  {
    title: 'フォーム入力・送信',
    body: 'Playwrightがフォームを自動入力。人の承認後に安全に送信。',
    icon: MailCheck,
  },
];

const stats = [
  { label: '作業時間', prefix: '平均', value: '45', suffix: '%削減', icon: Clock3 },
  { label: '送信数', prefix: '平均', value: '28', suffix: '%向上', icon: Users },
  { label: '送信精度', prefix: '', value: '98.2', suffix: '%', icon: ShieldCheck },
  { label: '商談化率', prefix: '平均', value: '32', suffix: '%向上', icon: LineChart },
];

const comparisonRows = [
  ['初期費用', '¥0', '10〜50万円/月', '時間コスト'],
  ['月額費用', '¥0', '3〜10万円/月', '時間コスト'],
  ['カスタマイズ性', '◎ ソース公開', '△ 制限あり', '×'],
  ['送信の安全性', '◎ 承認フロー', '○', '△ ミスのリスク'],
  ['商用利用', '◎ MIT License', '○ プランによる', '×'],
  ['データの所有権', '◎ ローカル', '△ クラウド', '○'],
  ['拡張性', '◎ プラグイン', '△', '×'],
];

const testimonials = [
  {
    company: '株式会社スタートアップA',
    role: '営業責任者',
    quote: '週10時間かかっていた作業が3時間に。今は商談に集中できます。',
  },
  {
    company: 'S企業 B',
    role: 'セールス',
    quote: 'AIが提案文を作ってくれるので、送信率が明らかに上がりました。',
  },
  {
    company: 'フリーランス営業 C',
    role: '代表',
    quote: '一人でも効率的に数を打てるので、案件獲得が安定しました。',
  },
];

const faqs = [
  'Sales ClawはどのAIと連携できますか？',
  '導入までにどのくらい時間がかかりますか？',
  'CAPTCHAへの対応はしていますか？',
  '誤送信を防ぐ仕組みはありますか？',
  '商用利用は可能ですか？',
];

const heroMetrics = [
  ['送信済み', '128件'],
  ['承認待ち', '12件'],
  ['成功率', '98.2%'],
];

const architectureHighlights = [
  {
    title: 'AI CLIが企業分析と文面作成を担当',
    body: 'Claude / Codex / Geminiを選び、営業リストや企業情報から送信候補ごとの提案文を組み立てます。',
    icon: Code2,
  },
  {
    title: 'MCP Playwrightがフォーム操作を実行',
    body: 'フォーム構造を読み取り、入力・確認・スクリーンショット取得までブラウザ上で確実に進めます。',
    icon: PlaywrightIcon,
  },
  {
    title: '人の承認とローカル保存を中核に配置',
    body: '送信前の確認、除外ルール、履歴保存を挟むことで、自動化しながら安全性を保ちます。',
    icon: ShieldCheck,
  },
];

function ClaudeIcon({ className }: IconProps) {
  return (
    <svg className={className} fill="#D97757" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

function GithubIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.92.58.11.79-.25.79-.56v-2.15c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.74 2.67 1.24 3.32.95.1-.74.4-1.24.72-1.53-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18A10.8 10.8 0 0 1 12 6.05c.97 0 1.94.13 2.86.39 2.19-1.49 3.15-1.18 3.15-1.18.62 1.58.23 2.75.11 3.04.73.8 1.17 1.83 1.17 3.08 0 4.42-2.69 5.38-5.25 5.67.41.36.77 1.06.77 2.13v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"
      />
    </svg>
  );
}

function OpenAiIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 256 260" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="currentColor" d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
    </svg>
  );
}

function GeminiIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 256 256" fill="none" aria-hidden="true">
      <path d="m45.8 0.09h164.1c25.35 0 45.83 20.72 45.83 46.3v163.1c0 25.58-21 46.33-46.48 46.33h-163.2c-25.48 0-45.99-21.16-45.99-46.3v-162.9c0-25.77 20.75-46.52 45.76-46.52z" fill="url(#gemini-a)" />
      <path d="m46.82 14.06h161.9c18.49 0 32.5 15.43 32.5 33.06v161.8c0 18.33-14.53 32.49-32.56 32.49h-161.7c-18.03 0-32.86-13.85-32.86-32.27v-162.4c0-17.66 14.43-32.61 32.76-32.61z" fill="#1F1D2E" />
      <path d="m76.93 62.08 102.2 49.64v38.76l-102.4 49.43v-28.46l82.28-40.62-82.06-39.3v-29.45z" fill="url(#gemini-b)" />
      <defs>
        <linearGradient id="gemini-a" x1="10.83" x2="245.5" y1="24.31" y2="238.7" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0083FF" />
          <stop offset=".23" stopColor="#2384FF" />
          <stop offset=".41" stopColor="#0186FF" />
          <stop offset=".59" stopColor="#A774DB" />
          <stop offset=".83" stopColor="#E0597A" />
          <stop offset="1" stopColor="#E0597A" />
        </linearGradient>
        <linearGradient id="gemini-b" x1="71.54" x2="162.7" y1="100.5" y2="151.2" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0186FF" />
          <stop offset=".5" stopColor="#0186FF" />
          <stop offset=".96" stopColor="#B878D6" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function WindowsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M3 5.2 10.8 4v7.5H3V5.2Zm8.7-1.35L21 2.5v9h-9.3V3.85ZM3 12.5h7.8V20L3 18.8v-6.3Zm8.7 0H21v9l-9.3-1.35V12.5Z" />
    </svg>
  );
}

function AppleIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 814 1000" aria-hidden="true">
      <path fill="currentColor" d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z" />
    </svg>
  );
}

function LinuxIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <path fill="#111827" d="M16.2 2.5c4.2 0 6.1 3.5 5.8 8.3-.1 2.2 1.2 4 2.8 6.3 2.4 3.5 2.9 8.9.2 11.4-1.8 1.7-4.6.6-6.5.3-1.2-.2-2.6-.2-3.8 0-1.9.3-4.7 1.4-6.5-.3-2.7-2.5-2.2-7.9.2-11.4 1.6-2.3 2.9-4.1 2.8-6.3-.3-4.8.8-8.3 5-8.3Z" />
      <path fill="#f9fafb" d="M12.1 14.3c.3-2.7 1.7-4.1 4.1-4.1 2.5 0 4 1.4 4.3 4.1.3 2.5 1.8 4.9 2.3 7.8.5 3.2-2.7 5-6.6 5-3.8 0-7.1-1.8-6.6-5 .5-2.9 2.2-5.3 2.5-7.8Z" />
      <path fill="#f59e0b" d="M12.3 27.1c-2.9 2.2-6.3 2-6.3.2 0-.9 1.7-1.6 2.5-2.7.8-1 1-2.6 2.2-2.8 1.8-.3 3.2 3.9 1.6 5.3Zm7.6 0c2.9 2.2 6.3 2 6.3.2 0-.9-1.7-1.6-2.5-2.7-.8-1-1-2.6-2.2-2.8-1.8-.3-3.2 3.9-1.6 5.3Zm-5.6-16c.9-.7 2.8-.7 3.7 0 .4.3.3.9-.2 1.1l-1.7.8-1.7-.8c-.4-.2-.5-.8-.1-1.1Z" />
      <path fill="#111827" d="M13.4 8.6c0 .8-.4 1.4-.9 1.4s-1-.6-1-1.4.4-1.4 1-1.4.9.6.9 1.4Zm7.5 0c0 .8-.4 1.4-.9 1.4s-1-.6-1-1.4.4-1.4 1-1.4.9.6.9 1.4Z" />
    </svg>
  );
}

function PlaywrightIcon({ className }: IconProps) {
  return (
    <svg className={className} width="400" height="400" viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M136.444 221.556C123.558 225.213 115.104 231.625 109.535 238.032C114.869 233.364 122.014 229.08 131.652 226.348C141.51 223.554 149.92 223.574 156.869 224.915V219.481C150.941 218.939 144.145 219.371 136.444 221.556ZM108.946 175.876L61.0895 188.484C61.0895 188.484 61.9617 189.716 63.5767 191.36L104.153 180.668C104.153 180.668 103.578 188.077 98.5847 194.705C108.03 187.559 108.946 175.876 108.946 175.876ZM149.005 288.347C81.6582 306.486 46.0272 228.438 35.2396 187.928C30.2556 169.229 28.0799 155.067 27.5 145.928C27.4377 144.979 27.4665 144.179 27.5336 143.446C24.04 143.657 22.3674 145.473 22.7077 150.721C23.2876 159.855 25.4633 174.016 30.4473 192.721C41.2301 233.225 76.8659 311.273 144.213 293.134C158.872 289.185 169.885 281.992 178.152 272.81C170.532 279.692 160.995 285.112 149.005 288.347ZM161.661 128.11V132.903H188.077C187.535 131.206 186.989 129.677 186.447 128.11H161.661Z" fill="#2D4552" />
      <path d="M193.981 167.584C205.861 170.958 212.144 179.287 215.465 186.658L228.711 190.42C228.711 190.42 226.904 164.623 203.57 157.995C181.741 151.793 168.308 170.124 166.674 172.496C173.024 167.972 182.297 164.268 193.981 167.584ZM299.422 186.777C277.573 180.547 264.145 198.916 262.535 201.255C268.89 196.736 278.158 193.031 289.837 196.362C301.698 199.741 307.976 208.06 311.307 215.436L324.572 219.212C324.572 219.212 322.736 193.41 299.422 186.777ZM286.262 254.795L176.072 223.99C176.072 223.99 177.265 230.038 181.842 237.869L274.617 263.805C282.255 259.386 286.262 254.795 286.262 254.795ZM209.867 321.102C122.618 297.71 133.166 186.543 147.284 133.865C153.097 112.156 159.073 96.0203 164.029 85.204C161.072 84.5953 158.623 86.1529 156.203 91.0746C150.941 101.747 144.212 119.124 137.7 143.45C123.586 196.127 113.038 307.29 200.283 330.682C241.406 341.699 273.442 324.955 297.323 298.659C274.655 319.19 245.714 330.701 209.867 321.102Z" fill="#2D4552" />
      <path d="M161.661 262.296V239.863L99.3324 257.537C99.3324 257.537 103.938 230.777 136.444 221.556C146.302 218.762 154.713 218.781 161.661 220.123V128.11H192.869C189.471 117.61 186.184 109.526 183.423 103.909C178.856 94.612 174.174 100.775 163.545 109.665C156.059 115.919 137.139 129.261 108.668 136.933C80.1966 144.61 57.179 142.574 47.5752 140.911C33.9601 138.562 26.8387 135.572 27.5049 145.928C28.0847 155.062 30.2605 169.224 35.2445 187.928C46.0272 228.433 81.663 306.481 149.01 288.342C166.602 283.602 179.019 274.233 187.626 262.291H161.661V262.296ZM61.0848 188.484L108.946 175.876C108.946 175.876 107.551 194.288 89.6087 199.018C71.6614 203.743 61.0848 188.484 61.0848 188.484Z" fill="#E2574C" />
      <path d="M341.786 129.174C329.345 131.355 299.498 134.072 262.612 124.185C225.716 114.304 201.236 97.0224 191.537 88.8994C177.788 77.3834 171.74 69.3802 165.788 81.4857C160.526 92.163 153.797 109.54 147.284 133.866C133.171 186.543 122.623 297.706 209.867 321.098C297.093 344.47 343.53 242.92 357.644 190.238C364.157 165.917 367.013 147.5 367.799 135.625C368.695 122.173 359.455 126.078 341.786 129.174ZM166.497 172.756C166.497 172.756 180.246 151.372 203.565 158C226.899 164.628 228.706 190.425 228.706 190.425L166.497 172.756ZM223.42 268.713C182.403 256.698 176.077 223.99 176.077 223.99L286.262 254.796C286.262 254.791 264.021 280.578 223.42 268.713ZM262.377 201.495C262.377 201.495 276.107 180.126 299.422 186.773C322.736 193.411 324.572 219.208 324.572 219.208L262.377 201.495Z" fill="#2EAD33" />
      <path d="M139.88 246.04L99.3324 257.532C99.3324 257.532 103.737 232.44 133.607 222.496L110.647 136.33L108.663 136.933C80.1918 144.611 57.1742 142.574 47.5704 140.911C33.9554 138.563 26.834 135.572 27.5001 145.929C28.08 155.063 30.2557 169.224 35.2397 187.929C46.0225 228.433 81.6583 306.481 149.005 288.342L150.989 287.719L139.88 246.04ZM61.0848 188.485L108.946 175.876C108.946 175.876 107.551 194.288 89.6087 199.018C71.6615 203.743 61.0848 188.485 61.0848 188.485Z" fill="#D65348" />
      <path d="M225.27 269.163L223.415 268.712C182.398 256.698 176.072 223.99 176.072 223.99L232.89 239.872L262.971 124.281L262.607 124.185C225.711 114.304 201.232 97.0224 191.532 88.8994C177.783 77.3834 171.735 69.3802 165.783 81.4857C160.526 92.163 153.797 109.54 147.284 133.866C133.171 186.543 122.623 297.706 209.867 321.097L211.655 321.5L225.27 269.163ZM166.497 172.756C166.497 172.756 180.246 151.372 203.565 158C226.899 164.628 228.706 190.425 228.706 190.425L166.497 172.756Z" fill="#1D8D22" />
      <path d="M141.946 245.451L131.072 248.537C133.641 263.019 138.169 276.917 145.276 289.195C146.513 288.922 147.74 288.687 149 288.342C152.302 287.451 155.364 286.348 158.312 285.145C150.371 273.361 145.118 259.789 141.946 245.451ZM137.7 143.451C132.112 164.307 127.113 194.326 128.489 224.436C130.952 223.367 133.554 222.371 136.444 221.551L138.457 221.101C136.003 188.939 141.308 156.165 147.284 133.866C148.799 128.225 150.318 122.978 151.832 118.085C149.393 119.637 146.767 121.228 143.776 122.867C141.759 129.093 139.722 135.898 137.7 143.451Z" fill="#C04B41" />
    </svg>
  );
}

function PuppeteerIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 42 42" aria-hidden="true">
      <path fill="#f8fafc" stroke="#0b0f19" strokeWidth="2.2" d="M8.5 20.8h25v16.7a3 3 0 0 1-3 3h-19a3 3 0 0 1-3-3V20.8Z" />
      <path fill="#0b0f19" d="M8.5 25h25v2.2h-25zM11.3 23.5a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2Zm4.1 0a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2Zm4.1 0a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2Z" />
      <path fill="#12d6b0" stroke="#0b0f19" strokeLinejoin="round" strokeWidth="2.2" d="m10.1 5.5 3-3 25.1 11.4-3 3L10.1 5.5Z" />
      <path fill="#12d6b0" stroke="#0b0f19" strokeLinejoin="round" strokeWidth="2.2" d="m31.9 2.5 3 3L9.8 17l-3-3L31.9 2.5Z" />
      <path stroke="#0b0f19" strokeLinecap="round" strokeWidth="2" d="M12.8 15.8 10.9 21m18.4-5.2 1.9 5.2" />
    </svg>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white px-4 py-1.5 text-sm font-semibold text-blue-700 shadow-sm">
      {children}
    </span>
  );
}

function Logo() {
  return (
    <a href="#top" className="flex items-center gap-3" aria-label="Sales Claw home">
      <Image src="/images/sales-claw-logo.png" alt="" width={48} height={48} className="h-12 w-12 rounded-[10px] shadow-md" priority />
      <span className="text-3xl font-black tracking-normal text-slate-950 max-sm:text-2xl">Sales Claw</span>
    </a>
  );
}

function PrimaryButton({ children, href = '#download' }: { children: React.ReactNode; href?: string }) {
  return (
    <a
      href={href}
      className="primary-cta inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-base font-bold shadow-[0_10px_24px_rgba(37,99,235,.24)] transition hover:bg-blue-700"
      style={{ color: '#ffffff' }}
    >
      {children}
    </a>
  );
}

function SecondaryButton({ children, href = '#github' }: { children: React.ReactNode; href?: string }) {
  return (
    <a
      href={href}
      className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-6 py-3 text-base font-bold text-slate-950 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
    >
      {children}
    </a>
  );
}

export default function Home() {
  return (
    <main id="top" className="page-shell">
      <header className="site-header">
        <div className="section header-panel">
          <Logo />
          <nav className="hidden items-center gap-10 text-sm font-bold lg:flex">
            {navItems.map((item) => (
              <a key={item} href={`#${item}`} className="nav-link transition">
                {item}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <div className="hidden items-center gap-3 lg:flex">
              <SecondaryButton href="#github">
                <GithubIcon className="h-5 w-5" />
                GitHub
              </SecondaryButton>
              <PrimaryButton>
                <Download className="h-5 w-5" />
                ダウンロード
              </PrimaryButton>
            </div>
            <button className="mobile-menu-button inline-flex h-11 w-11 items-center justify-center rounded-xl lg:hidden" aria-label="menu">
              <Menu className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      <section className="hero-scene">
        <div className="hero-grid" />
        <div className="hero-beam hero-beam-one" />
        <div className="hero-beam hero-beam-two" />
        <div className="section hero-inner grid grid-cols-[.9fr_1.1fr] items-center gap-10 max-lg:grid-cols-1">
        <div className="relative z-10 max-w-3xl">
          <div className="flex flex-wrap items-center gap-4">
            <Badge>Public Beta</Badge>
            <span className="text-sm font-semibold text-blue-100">14日間無料トライアル</span>
          </div>
          <h1 className="mt-7 text-5xl font-black leading-[1.12] tracking-normal text-white max-xl:text-[44px] max-sm:text-[31px]">
            問い合わせフォーム営業を、
            <br />
            AIで<span className="text-cyan-200">“実行できる業務”</span>に変える。
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-9 text-blue-50/90">
            Sales Clawは、AIとPlaywrightが連携し、企業分析からメッセージ作成、フォーム送信までを自動化。
            人の判断を残した、安全で成果の出る営業を実現します。
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <PrimaryButton>
              <WindowsIcon className="h-5 w-5 text-white" />
              無料でダウンロード
              <span className="text-xs font-semibold opacity-80">Windows / macOS</span>
            </PrimaryButton>
            <SecondaryButton>
              <GithubIcon className="h-5 w-5" />
              GitHubで見る
            </SecondaryButton>
          </div>
          <div className="mt-8 flex flex-wrap gap-x-7 gap-y-3 text-sm font-semibold text-blue-50/86">
            {['クレジットカード不要', 'MIT License', '商用利用OK', '日本語サポート'].map((item) => (
              <span key={item} className="inline-flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-cyan-200" />
                {item}
              </span>
            ))}
          </div>
        </div>

        <div className="hero-visual-wrap">
          <div className="hero-metric-card hero-metric-card-left">
            <span>AI分析</span>
            <strong>自動化</strong>
          </div>
          <div className="hero-scroll-frame">
            <Image
              src="/images/sales-claw-hero-stage.png"
              alt="Sales Clawの分析ダッシュボードと自動化フローを表示したノートPCとスマートフォン"
              width={1792}
              height={1024}
              priority
              className="hero-image-frame h-full w-full object-contain"
            />
            <div className="hero-frame-overlay" />
          </div>
          <div className="hero-stat-row">
            {heroMetrics.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </div>
        </div>
      </section>

      <section className="section relative z-10 -mt-8 py-4">
        <div className="tech-strip hairline-card grid grid-cols-3 divide-x divide-slate-200/80 px-8 py-7 max-lg:grid-cols-1 max-lg:divide-x-0 max-lg:divide-y">
          <div className="flex flex-col items-center gap-5 py-2">
            <p className="text-sm font-bold text-slate-700">対応 AI CLI</p>
            <div className="flex flex-wrap items-center justify-center gap-8">
              <span className="inline-flex items-center gap-2 text-sm font-semibold"><ClaudeIcon className="h-7 w-7" />Claude</span>
              <span className="inline-flex items-center gap-2 text-sm font-semibold"><OpenAiIcon className="h-7 w-7 text-slate-950" />Codex</span>
              <span className="inline-flex items-center gap-2 text-sm font-semibold"><GeminiIcon className="h-7 w-7" />Gemini</span>
            </div>
          </div>
          <div className="flex flex-col items-center gap-5 py-2">
            <p className="text-sm font-bold text-slate-700">対応 OS</p>
            <div className="flex flex-wrap items-center justify-center gap-8">
              <span className="inline-flex items-center gap-2 text-sm font-semibold"><WindowsIcon className="h-7 w-7 text-[#0078d4]" />Windows</span>
              <span className="inline-flex items-center gap-2 text-sm font-semibold"><AppleIcon className="h-7 w-7 text-slate-950" />macOS</span>
              <span className="inline-flex items-center gap-2 text-sm font-semibold"><LinuxIcon className="h-7 w-7" />Linux</span>
            </div>
          </div>
          <div className="flex flex-col items-center gap-5 py-2">
            <p className="text-sm font-bold text-slate-700">主要依存ライブラリ</p>
            <div className="flex flex-wrap items-center justify-center gap-8">
              <span className="inline-flex items-center gap-2 text-sm font-semibold"><PlaywrightIcon className="h-9 w-9" />MCP Playwright</span>
              <span className="inline-flex items-center gap-2 text-sm font-semibold"><PuppeteerIcon className="h-9 w-9" />Puppeteer</span>
            </div>
          </div>
        </div>
      </section>

      <section className="architecture-band">
        <div className="section architecture-section">
          <div className="architecture-intro">
            <div>
              <span className="section-kicker">Architecture</span>
              <h2>
                <span>Sales Claw</span>
                <span className="architecture-title-ja">アーキテクチャ</span>
              </h2>
            </div>
            <p>
              AI CLIで企業分析とメッセージ生成を行い、MCP Playwrightがブラウザ上でフォーム操作を実行。
              最後に人の承認を挟むことで、自動化の速さと営業品質の安全性を両立します。
            </p>
          </div>
          <div className="architecture-diagram-card">
            <Image
              src="/images/sales-claw-architecture-flow.png"
              alt="Sales Clawの入力、AI CLI、Sales Clawコアエンジン、MCP Playwright、承認、送信実行、出力結果までのアーキテクチャ図"
              width={1632}
              height={1080}
              className="architecture-diagram"
            />
          </div>
          <div className="architecture-highlight-grid">
            {architectureHighlights.map(({ title, body, icon: Icon }) => (
              <article key={title} className="architecture-highlight-card">
                <div className="architecture-highlight-icon">
                  <Icon className="h-7 w-7" />
                </div>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="機能" className="section py-10">
        <h2 className="text-center text-3xl font-black tracking-normal text-slate-950">Sales Clawが選ばれる理由</h2>
        <div className="mt-7 grid grid-cols-4 gap-5 max-xl:grid-cols-2 max-md:grid-cols-1">
          {reasonCards.map(({ title, body, icon: Icon }) => (
            <article key={title} className="hairline-card flex min-h-28 items-center gap-5 p-6">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                <Icon className="h-8 w-8" />
              </div>
              <div>
                <h3 className="font-black text-slate-950">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section id="使い方" className="section py-3">
        <h2 className="text-center text-3xl font-black tracking-normal text-slate-950">3ステップで、問い合わせ送信まで完了</h2>
        <div className="mt-5 grid grid-cols-[1fr_72px_1fr_72px_1fr] items-center gap-3 max-lg:grid-cols-1">
          {workflowSteps.map(({ title, body, icon: Icon }, index) => (
            <div key={title} className="contents max-lg:block">
              <article className="hairline-card flex min-h-32 items-center gap-6 p-7">
                <div className="flex h-20 w-20 shrink-0 items-center justify-center text-blue-700">
                  <Icon className="h-14 w-14" />
                </div>
                <div>
                  <h3 className="text-lg font-black text-slate-950">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
                </div>
              </article>
              {index < workflowSteps.length - 1 && (
                <div className="flex items-center justify-center max-lg:py-3">
                  <ArrowRight className="workflow-arrow h-10 w-10 max-lg:rotate-90" />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section id="導入事例" className="section py-10">
        <h2 className="text-center text-3xl font-black tracking-normal text-slate-950">導入すると、こんなに変わります</h2>
        <div className="mt-6 grid grid-cols-4 gap-5 max-xl:grid-cols-2 max-md:grid-cols-1">
          {stats.map(({ label, prefix, value, suffix, icon: Icon }) => (
            <article key={label} className="hairline-card flex min-h-24 items-center justify-center gap-6 p-5">
              <Icon className="h-10 w-10 text-slate-400" />
              <div>
                <p className="text-sm font-bold text-slate-600">{label}</p>
                <p className="mt-1 text-lg font-bold text-slate-950">
                  {prefix && <span className="mr-2 text-sm text-slate-600">{prefix}</span>}
                  <span className="font-mono text-4xl text-slate-950">{value}</span>
                  <span className="ml-1">{suffix}</span>
                </p>
              </div>
            </article>
          ))}
        </div>
        <p className="mt-4 text-center text-xs font-semibold text-slate-400">導入企業の平均値（当社調べ）</p>
      </section>

      <section id="料金" className="section grid grid-cols-[1fr_1.12fr] gap-10 py-6 max-xl:grid-cols-1">
        <div>
          <h2 className="mb-4 text-xl font-black text-slate-950">他サービスとの比較</h2>
          <div className="hairline-card overflow-x-auto">
            <div className="table-grid min-w-[720px] text-sm">
              {['', 'Sales Claw (OSS)', 'SaaS営業支援ツール', '手動での営業'].map((head) => (
                <div key={head} className={`px-5 py-3 text-center font-black ${head.includes('Sales') ? 'bg-blue-50 text-blue-700' : 'bg-slate-50 text-slate-800'}`}>
                  {head}
                </div>
              ))}
              {comparisonRows.flatMap((row) =>
                row.map((cell, cellIndex) => (
                  <div
                    key={`${row[0]}-${cellIndex}`}
                    className={`comparison-row px-5 py-3 ${cellIndex === 1 ? 'bg-blue-50/70 text-center font-black text-blue-700' : cellIndex === 0 ? 'font-bold text-slate-800' : 'text-center text-slate-600'}`}
                  >
                    {cell}
                  </div>
                )),
              )}
            </div>
          </div>
          <a href="#docs" className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-blue-600">
            すべての比較項目を見る <ArrowRight className="h-4 w-4" />
          </a>
        </div>

        <div>
          <h2 className="mb-4 text-xl font-black text-slate-950">導入企業の声</h2>
          <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
            {testimonials.map((item) => (
              <article key={item.company} className="hairline-card p-6">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700">
                    <Users className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-black text-slate-950">{item.company}</p>
                    <p className="text-xs font-semibold text-slate-500">{item.role}</p>
                  </div>
                </div>
                <p className="mt-5 text-sm leading-7 text-slate-700">「{item.quote}」</p>
              </article>
            ))}
          </div>
          <a href="#stories" className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-blue-600">
            すべての事例を見る <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </section>

      <section id="よくある質問" className="section grid grid-cols-[.95fr_.95fr_1.05fr] gap-5 py-10 max-xl:grid-cols-1">
        <div className="hairline-card p-6">
          <h2 className="text-xl font-black text-slate-950">よくある質問</h2>
          <div className="mt-4 divide-y divide-slate-200">
            {faqs.map((faq) => (
              <button key={faq} className="flex w-full items-center justify-between gap-3 py-3 text-left text-sm font-semibold text-slate-700">
                <span className="inline-flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-blue-200 text-xs text-blue-700">?</span>
                  {faq}
                </span>
                <ArrowRight className="h-4 w-4 text-slate-400" />
              </button>
            ))}
          </div>
          <a className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-blue-600" href="#faq">
            すべてのFAQを見る <ArrowRight className="h-4 w-4" />
          </a>
        </div>

        <div className="hairline-card p-6">
          <h2 className="text-xl font-black text-slate-950">アーキテクチャ</h2>
          <div className="mt-8 flex flex-col items-center gap-5">
            <div className="flex w-full items-center justify-between gap-2">
              {[
                ['AI CLI', 'Claude / Codex / Gemini'],
                ['Sales Claw', 'Core'],
                ['MCP Playwright', 'Browser Automation'],
              ].map(([title, label], index) => (
                <div key={title} className="contents">
                  <div className="flex min-h-16 flex-1 flex-col items-center justify-center rounded-lg border border-slate-200 bg-white text-center">
                    <span className="text-sm font-black text-slate-950">{title}</span>
                    <span className="mt-1 text-[11px] font-semibold text-slate-500">{label}</span>
                  </div>
                  {index < 2 && <ArrowRight className="h-5 w-5 shrink-0 text-slate-400" />}
                </div>
              ))}
            </div>
            <div className="flex w-2/3 items-center justify-center rounded-lg border border-slate-200 bg-white px-5 py-4 text-sm font-bold text-slate-700">
              <Database className="mr-3 h-6 w-6 text-blue-600" />
              ローカルデータベース
            </div>
          </div>
        </div>

        <div id="download" className="hairline-card p-6">
          <h2 className="text-xl font-black text-slate-950">クイックスタート</h2>
          <div className="code-panel mt-4 overflow-hidden">
            <div className="flex border-b border-white/10 text-xs font-bold text-slate-300">
              {['npm', 'pnpm', 'yarn'].map((tool, index) => (
                <span key={tool} className={`px-7 py-3 ${index === 0 ? 'bg-blue-500/20 text-white' : ''}`}>{tool}</span>
              ))}
            </div>
            <pre className="overflow-x-auto p-5 text-sm leading-7">
              <code>{`# インストール
npm install -g salesclaw

# 初期化
salesclaw init

# 起動
salesclaw start`}</code>
            </pre>
          </div>
          <a className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-blue-600" href="#docs">
            詳しい使い方を見る <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </section>

      <section className="section pb-10">
        <div className="dark-panel flex items-center justify-between gap-8 rounded-lg px-12 py-9 max-lg:flex-col max-lg:items-start max-sm:px-6">
          <div className="flex items-center gap-8 max-sm:flex-col max-sm:items-start">
            <Image src="/images/sales-claw-logo.png" alt="" width={120} height={120} className="h-28 w-28 rounded-2xl" />
            <div>
              <h2 className="text-3xl font-black tracking-normal text-white max-sm:text-2xl">今すぐSales Clawで、営業をもっとスマートに。</h2>
              <p className="mt-3 text-lg font-semibold text-blue-100">14日間無料で、すべての機能をお試しいただけます。</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-4">
            <PrimaryButton>
              <WindowsIcon className="h-5 w-5 text-white" />
              無料でダウンロード
            </PrimaryButton>
            <a
              id="github"
              href="https://github.com/"
              className="dark-secondary-cta inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/30 bg-white/5 px-6 py-3 text-base font-bold transition hover:bg-white/10"
              style={{ color: '#ffffff' }}
            >
              <GithubIcon className="h-5 w-5" />
              GitHubでスターをつける
            </a>
          </div>
        </div>
      </section>

      <footer id="ドキュメント" className="border-t border-slate-200 bg-white">
        <div className="section grid grid-cols-[1.45fr_repeat(5,1fr)] gap-8 py-9 text-sm max-xl:grid-cols-3 max-md:grid-cols-1">
          <div>
            <p className="text-xl font-black text-slate-950">Sales Claw</p>
            <p className="mt-3 max-w-xs leading-6 text-slate-600">AIとPlaywrightで、問い合わせフォーム営業を自動化するOSS</p>
            <p className="mt-4 text-xs font-semibold text-slate-500">© 2026 Sales Claw. All rights reserved.</p>
          </div>
          {[
            ['プロダクト', '機能', '料金', '使い方', 'ドキュメント'],
            ['リソース', '導入事例', 'ブログ', 'Changelog', 'Roadmap'],
            ['コミュニティ', 'GitHub', 'Discord', 'X (Twitter)', 'Issue'],
            ['法的情報', 'ライセンス', 'プライバシー', '行動規範'],
            ['お問い合わせ', 'contact@salesclaw.dev'],
          ].map(([title, ...links]) => (
            <div key={title}>
              <p className="font-black text-slate-950">{title}</p>
              <div className="mt-3 flex flex-col gap-2 text-slate-600">
                {links.map((link) => (
                  <a key={link} href="#top" className="hover:text-blue-700">
                    {link}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </footer>
    </main>
  );
}
