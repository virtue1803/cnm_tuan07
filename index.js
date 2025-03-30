const AWS = require('aws-sdk');
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Cấu hình Multer (lưu file tạm thời, không dùng public/uploads nữa)
const storage = multer.diskStorage({
    destination: './tmp/',
    filename: (req, file, cb) => {
        const fileName = Date.now() + path.extname(file.originalname);
        console.log(`Uploading file: ${file.originalname} -> ${fileName}`);
        cb(null, fileName);
    }
});
const upload = multer({ storage: storage });
require('dotenv').config();

// AWS config
AWS.config.update({
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const s3 = new AWS.S3();
const BUCKET_NAME = process.env.BUCKET_NAME;
const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL;

const dynamodb = new AWS.DynamoDB();
const docClient = new AWS.DynamoDB.DocumentClient();

// Tạo bảng nếu chưa tồn tại
async function createTableIfNotExists() {
    const tableName = 'SanPham';
    try {
        console.log(`Checking if table ${tableName} exists...`);
        await dynamodb.describeTable({ TableName: tableName }).promise();
        console.log(`Table ${tableName} already exists`);
    } catch (error) {
        if (error.code === 'ResourceNotFoundException') {
            console.log(`Creating new table ${tableName}...`);
            const params = {
                TableName: tableName,
                KeySchema: [{ AttributeName: 'maSanPham', KeyType: 'HASH' }],
                AttributeDefinitions: [{ AttributeName: 'maSanPham', AttributeType: 'S' }],
                ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
            };
            await dynamodb.createTable(params).promise();
            await dynamodb.waitFor('tableExists', { TableName: tableName }).promise();
            console.log(`Table ${tableName} is now active`);
        } else {
            console.error(`Error checking table ${tableName}:`, error);
            throw error;
        }
    }
}

// Trang chủ
app.get('/', async (req, res) => {
    console.log('GET / - Fetching all products');
    await createTableIfNotExists();

    const params = { TableName: 'SanPham' };
    docClient.scan(params, (err, data) => {
        if (err) {
            console.error('Error scanning DynamoDB:', err);
            res.render('index', { items: [] });
        } else {
            const sortedItems = data.Items.sort((a, b) => a.maSanPham.localeCompare(b.maSanPham));
            res.render('index', { items: sortedItems });
        }
    });
});

// Thêm sản phẩm
app.post('/insert', upload.single('hinhAnh'), async (req, res) => {
    const { tenSanPham, soLuong } = req.body;

    const uuid = uuidv4();
    const maSanPham = `SP-${uuid.split('-')[0].toUpperCase()}`; // ex: SP-B767F11A

    let hinhAnhUrl = null;

    if (req.file) {
        const fileContent = fs.readFileSync(req.file.path);
        const s3Key = `images/${Date.now()}_${req.file.originalname}`;
        const s3Params = {
            Bucket: BUCKET_NAME,
            Key: s3Key,
            Body: fileContent,
            ContentType: req.file.mimetype
        };

        try {
            await s3.upload(s3Params).promise();
            hinhAnhUrl = `${CLOUDFRONT_URL}/${s3Key}`;
        } catch (err) {
            console.error('S3 upload failed:', err);
            return res.status(500).send('Upload failed');
        }

        fs.unlinkSync(req.file.path);
    }

    const params = {
        TableName: 'SanPham',
        Item: {
            maSanPham,
            uuid,
            tenSanPham,
            soLuong: parseInt(soLuong),
            hinhAnh: hinhAnhUrl
        }
    };

    docClient.put(params, (err) => {
        if (err) {
            console.error('Insert error:', err);
        }
        res.redirect('/');
    });
});



// Cập nhật sản phẩm
app.post('/update', upload.single('hinhAnh'), async (req, res) => {
    const { maSanPham, tenSanPham, soLuong, currentHinhAnh } = req.body;
    let hinhAnhUrl = currentHinhAnh;

    if (req.file) {
        const fileContent = fs.readFileSync(req.file.path);
        const s3Key = `images/${Date.now()}_${req.file.originalname}`;
        const s3Params = {
            Bucket: BUCKET_NAME,
            Key: s3Key,
            Body: fileContent,
            ContentType: req.file.mimetype,
            ACL: 'public-read'
        };

        try {
            await s3.upload(s3Params).promise();
            hinhAnhUrl = `${CLOUDFRONT_URL}/${s3Key}`;
            console.log('Uploaded updated image to S3:', hinhAnhUrl);
        } catch (err) {
            console.error('S3 upload failed:', err);
        }

        fs.unlinkSync(req.file.path);
    }

    const params = {
        TableName: 'SanPham',
        Key: { maSanPham },
        UpdateExpression: 'set tenSanPham = :ten, soLuong = :sl, hinhAnh = :ha',
        ExpressionAttributeValues: {
            ':ten': tenSanPham,
            ':sl': parseInt(soLuong),
            ':ha': hinhAnhUrl
        }
    };

    docClient.update(params, (err) => {
        if (err) {
            console.error('Update error:', err);
        } else {
            console.log(`Updated: ${maSanPham}`);
        }
        res.redirect('/');
    });
});

// Xoá sản phẩm
app.post('/delete', (req, res) => {
    const maSanPhamList = Array.isArray(req.body.maSanPham) ? req.body.maSanPham : [req.body.maSanPham];

    const deletePromises = maSanPhamList.map(maSanPham => {
        const params = {
            TableName: 'SanPham',
            Key: { maSanPham }
        };
        return docClient.delete(params).promise().catch(err => {
            console.error(`Delete error for ${maSanPham}:`, err);
        });
    });

    Promise.all(deletePromises).then(() => {
        console.log('Deleted selected products');
        res.redirect('/');
    }).catch(err => {
        console.error('Batch delete error:', err);
        res.redirect('/');
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
