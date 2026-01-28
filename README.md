# Realtime Quiz VN (Top 5 sau mỗi câu)

Web chơi quiz realtime (Socket.IO):
- Host tạo phòng -> mã phòng
- Người chơi nhập mã phòng + tên -> tham gia
- Tính điểm: đúng + nhanh
- Sau mỗi câu: hiện Top 5
- Kết thúc: hiện Top 15

## Deploy nhanh (không cần cài gì trên máy)

### Railway (khuyến nghị)
1) Tạo repo GitHub mới
2) Upload toàn bộ file trong ZIP này lên repo (package.json + server.js)
3) Railway: New Project -> Deploy from GitHub repo -> chọn repo
4) Tạo domain public (Generate Domain)
5) Mở:
   - /host  (Host)
   - /play  (Người chơi)

## Sửa câu hỏi
Mở `server.js` -> tìm `const QUIZ = { ... }` -> sửa:
- text
- choices
- correctIndex (0=A, 1=B, 2=C, 3=D)
- timeLimitSec (giây)

## Kiểm tra realtime có chạy chưa
Mở: https://<domain>/socket.io/socket.io.js
- Nếu ra file JS: OK
- Nếu 404: bạn deploy nhầm Static Site hoặc app chưa chạy
